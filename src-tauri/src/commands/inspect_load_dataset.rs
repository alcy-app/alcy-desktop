//! Bounded dataset column previews for load-flow data mapping.

use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use super::inspect_flow_output::FlowOutputQueries;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectLoadDatasetInput {
    root_path: String,
    flow_id: String,
    asset_id: String,
    query_id: String,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    query: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadDatasetField {
    name: String,
    preview: String,
    reference: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadDatasetFields {
    fields: Vec<LoadDatasetField>,
    next_offset: Option<usize>,
    rows: usize,
}

#[tauri::command]
pub async fn inspect_load_dataset(
    input: InspectLoadDatasetInput,
    queries: tauri::State<'_, FlowOutputQueries>,
) -> Result<LoadDatasetFields, String> {
    let cancelled = queries.begin(&input.query_id)?;
    let query_id = input.query_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || inspect_dataset(&input, &cancelled))
        .await
        .map_err(|_| "unavailable".to_string())
        .and_then(|result| result);
    queries.finish(&query_id);
    result
}

fn component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.contains(['/', '\\', ':'])
        && !matches!(value, "." | "..")
}

fn inspect_dataset(
    input: &InspectLoadDatasetInput,
    cancelled: &AtomicBool,
) -> Result<LoadDatasetFields, String> {
    if !component(&input.flow_id)
        || !component(&input.asset_id)
        || input.query.len() > 256
        || input.root_path.len() > 4096
    {
        return Err("invalidQuery".into());
    }
    let directory = Path::new(&input.root_path)
        .join("alcy-flow-assets")
        .join(&input.flow_id);
    let path = directory.join(&input.asset_id);
    let metadata = fs::symlink_metadata(&path).map_err(|_| "unavailable")?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > alcy_app::MAX_ITERATION_DATA_BYTES as u64
    {
        return Err("unavailable".into());
    }
    if cancelled.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    let mut text = String::new();
    fs::File::open(path)
        .map_err(|_| "unavailable")?
        .take(alcy_app::MAX_ITERATION_DATA_BYTES as u64 + 1)
        .read_to_string(&mut text)
        .map_err(|_| "unavailable")?;
    let data = alcy_app::parse_iteration_data(&text).map_err(|_| "invalidData")?;
    let mut result = LoadDatasetFields {
        fields: Vec::new(),
        next_offset: None,
        rows: data.rows.len(),
    };
    for (index, name) in data.columns.iter().enumerate().skip(input.offset) {
        if cancelled.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        if !name.to_lowercase().contains(&input.query.to_lowercase()) {
            continue;
        }
        if result.fields.len() == 100 {
            result.next_offset = Some(index);
            break;
        }
        let reference = (name.len() <= 512 && !name.contains(['{', '}']) && name.trim() == name)
            .then(|| format!("{{{{{name}}}}}"));
        let preview = data
            .rows
            .first()
            .and_then(|row| row.iter().find(|(key, _)| key == name))
            .map_or("", |(_, value)| value.as_str());
        result.fields.push(LoadDatasetField {
            name: name.chars().take(128).collect(),
            preview: preview.chars().take(128).collect(),
            reference,
        });
        if serde_json::to_vec(&result)
            .map_err(|_| "unavailable")?
            .len()
            > 48 * 1024
        {
            result.fields.pop();
            result.next_offset = Some(index);
            break;
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previews_only_a_bounded_column_page_and_rejects_path_traversal() {
        let root = std::env::temp_dir().join(format!(
            "alcy-dataset-preview-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("alcy-flow-assets/flow")).unwrap();
        let header = (0..250)
            .map(|index| format!("column{index}"))
            .collect::<Vec<_>>()
            .join(",");
        fs::write(
            root.join("alcy-flow-assets/flow/data.csv"),
            format!("{header}\n{}", vec!["value"; 250].join(",")),
        )
        .unwrap();
        let mut input = InspectLoadDatasetInput {
            root_path: root.to_string_lossy().into_owned(),
            flow_id: "flow".into(),
            asset_id: "data.csv".into(),
            query_id: "q".into(),
            offset: 100,
            query: String::new(),
        };
        let result = inspect_dataset(&input, &AtomicBool::new(false)).unwrap();
        assert_eq!(result.fields.len(), 100);
        assert_eq!(result.fields[0].reference.as_deref(), Some("{{column100}}"));
        assert_eq!(result.next_offset, Some(200));
        assert!(serde_json::to_vec(&result).unwrap().len() < 64 * 1024);
        input.asset_id = "../outside.csv".into();
        assert!(inspect_dataset(&input, &AtomicBool::new(false)).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
