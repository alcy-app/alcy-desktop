use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::flows::{FlowDto, FlowInput, FlowsError, flow_from_input, flow_to_dto};
use super::load_test_import::{
    LoadTestImportAnalysisDto, LoadTestImportErrorDto, analyze_load_test_source,
};

// Match the individual collection and load-source import limit.
const MAX_IMPORT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFlowInput {
    source_path: String,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FlowImportAnalysisDto {
    Alcy { flow: FlowDto },
    LoadTest { analysis: LoadTestImportAnalysisDto },
}

#[tauri::command]
pub async fn analyze_flow_import(
    input: ImportFlowInput,
) -> Result<FlowImportAnalysisDto, LoadTestImportErrorDto> {
    tauri::async_runtime::spawn_blocking(move || analyze_import(Path::new(&input.source_path)))
        .await
        .map_err(|error| LoadTestImportErrorDto::InvalidSource {
            message: error.to_string(),
        })?
}

fn analyze_import(path: &Path) -> Result<FlowImportAnalysisDto, LoadTestImportErrorDto> {
    let convert_error = |error| match error {
        FlowsError::Invalid { message } => LoadTestImportErrorDto::InvalidSource { message },
        FlowsError::Storage { message } => LoadTestImportErrorDto::Storage { message },
    };
    let bytes = read_source(path).map_err(convert_error)?;
    let text = std::str::from_utf8(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes))
        .map_err(|error| LoadTestImportErrorDto::InvalidSource {
            message: error.to_string(),
        })?;
    // Inspect content before the filename: an Alcy export may have been renamed.
    // The existing load analyzer uses both the extension and k6/JMeter signatures.
    if text.trim_start().starts_with(['{', '[']) {
        return decode_import(&bytes)
            .map(|flow| FlowImportAnalysisDto::Alcy { flow })
            .map_err(convert_error);
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| LoadTestImportErrorDto::InvalidSource {
            message: "Invalid import filename".into(),
        })?;
    analyze_load_test_source(name, &bytes)
        .map(|analysis| FlowImportAnalysisDto::LoadTest { analysis })
}

fn invalid(message: impl ToString) -> FlowsError {
    FlowsError::Invalid {
        message: message.to_string(),
    }
}

fn storage(error: std::io::Error) -> FlowsError {
    FlowsError::Storage {
        message: error.to_string(),
    }
}

/// Read and validate only. The frontend commits the imported graph through
/// its explicit snapshot save, preserving pending edits and folder membership.
#[tauri::command]
pub async fn import_flow(input: ImportFlowInput) -> Result<FlowDto, FlowsError> {
    let result =
        tauri::async_runtime::spawn_blocking(move || read_import(Path::new(&input.source_path)))
            .await
            .map_err(|e| FlowsError::Storage {
                message: e.to_string(),
            })?;
    crate::logging::logged("alcy::flow", "read flow import", result)
}

fn read_import(path: &Path) -> Result<FlowDto, FlowsError> {
    decode_import(&read_source(path)?)
}

fn read_source(path: &Path) -> Result<Vec<u8>, FlowsError> {
    let metadata = std::fs::symlink_metadata(path).map_err(storage)?;
    if !metadata.is_file() {
        return Err(invalid("Select a regular flow export file"));
    }
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err(invalid("Flow imports are limited to 2 MiB"));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(storage)?
        .take(MAX_IMPORT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(storage)?;
    if bytes.len() as u64 > MAX_IMPORT_BYTES {
        return Err(invalid("Flow imports are limited to 2 MiB"));
    }
    Ok(bytes)
}

fn decode_import(bytes: &[u8]) -> Result<FlowDto, FlowsError> {
    let graph = alcy_app::decode_flow_import(bytes).map_err(invalid)?;
    let input: FlowInput = serde_json::from_value(graph).map_err(invalid)?;
    Ok(flow_to_dto(&flow_from_input(input)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn imports_exports_and_rejects_invalid_graphs_and_oversized_files() {
        let root = std::env::temp_dir().join(format!(
            "alcy-import-flow-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("example.flow.alcy.json");
        let mut document = json!({"format":"alcy-flow","version":1,"flow":{
            "id":"original","name":"Example","executionKind":"standard","createdAtMs":0,"updatedAtMs":0,
            "nodes":[{"id":"start","kind":"start","x":0,"y":0},
                {"id":"log","kind":"display","template":"{{nodes.start.form.name}}","x":200,"y":0}],
            "edges":[{"id":"edge","sourceNodeId":"start","targetNodeId":"log"}]}});
        std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
        let first = read_import(&path).unwrap();
        let second = read_import(&path).unwrap();
        assert_ne!(first.id, "original");
        assert_ne!(first.id, second.id);
        assert_eq!(first.nodes, second.nodes);
        assert_eq!(first.edges, second.edges);
        let renamed = root.join("renamed.js");
        std::fs::copy(&path, &renamed).unwrap();
        assert!(matches!(
            analyze_import(&renamed).unwrap(),
            FlowImportAnalysisDto::Alcy { .. }
        ));
        assert!(!root.join("alcy-flows.json").exists());
        document["flow"]["edges"][0]["targetNodeId"] = json!("missing");
        std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
        assert!(read_import(&path).is_err());
        std::fs::File::create(&path)
            .unwrap()
            .set_len(MAX_IMPORT_BYTES + 1)
            .unwrap();
        assert!(read_import(&path).is_err());
        assert!(read_import(&root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detects_load_sources_by_content_with_different_extensions() {
        let root = std::env::temp_dir().join(format!(
            "alcy-detect-flow-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let k6 = "import http from 'k6/http'; export default function () { http.get('https://api.example.test'); }";
        let jmeter = r#"<jmeterTestPlan><hashTree><TestPlan testname="Smoke"/><hashTree>
            <ThreadGroup testname="Smoke"><stringProp name="ThreadGroup.num_threads">1</stringProp>
            <stringProp name="ThreadGroup.ramp_time">0</stringProp>
            <elementProp name="ThreadGroup.main_controller" elementType="LoopController">
            <boolProp name="LoopController.continue_forever">false</boolProp><intProp name="LoopController.loops">1</intProp>
            </elementProp></ThreadGroup><hashTree><HTTPSamplerProxy testname="health">
            <boolProp name="HTTPSampler.use_keepalive">true</boolProp>
            <stringProp name="HTTPSampler.protocol">https</stringProp><stringProp name="HTTPSampler.domain">example.test</stringProp>
            <stringProp name="HTTPSampler.path">/health</stringProp><stringProp name="HTTPSampler.method">GET</stringProp>
            </HTTPSamplerProxy><hashTree/></hashTree></hashTree></hashTree></jmeterTestPlan>"#;
        for (name, source, format) in [("script.json", k6, "k6"), ("plan.xml", jmeter, "jmeter")] {
            let path = root.join(name);
            std::fs::write(&path, source).unwrap();
            let FlowImportAnalysisDto::LoadTest { analysis } = analyze_import(&path).unwrap()
            else {
                panic!("expected a load source")
            };
            assert_eq!(analysis.format, format);
            assert!(!analysis.analysis_hash.is_empty());
            assert!(!root.join("alcy-flows.json").exists());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
