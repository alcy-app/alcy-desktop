use std::path::PathBuf;

use alcy_app::{FlowExportContext, FlowExportRequest, PreparedFlowExport, prepare_flow_export};
use alcy_domain::{
    EnvironmentVariable, FlowNodeKind, effective_authentication, find_saved_request,
    merge_variables, variable_scopes,
};
use alcy_storage::CollectionsStore;
use serde::{Deserialize, Serialize};

use super::collections::request_to_dto;
use super::environments::EnvironmentVariableDto;
use super::flows::{FlowInput, FlowsError, flow_from_input, flow_to_dto};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowExportInput {
    root_path: String,
    flow: FlowInput,
    environment_variables: Vec<EnvironmentVariableDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFlowExportInput {
    #[serde(flatten)]
    source: FlowExportInput,
    path: String,
    inline: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowExportPreview {
    request_count: usize,
    variable_count: usize,
    empty_variable_count: usize,
    can_inline: bool,
    has_dependencies: bool,
}

fn invalid(message: impl ToString) -> FlowsError {
    FlowsError::Invalid {
        message: message.to_string(),
    }
}

fn prepare(input: FlowExportInput, inline: bool) -> Result<PreparedFlowExport, FlowsError> {
    let flow = flow_from_input(input.flow)?;
    let variables = input
        .environment_variables
        .into_iter()
        .map(|v| {
            EnvironmentVariable::new(
                v.name,
                if v.sensitive { String::new() } else { v.value },
                v.sensitive,
            )
            .map_err(invalid)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let collections = if flow
        .nodes()
        .iter()
        .any(|node| matches!(node.kind, FlowNodeKind::Request { .. }))
    {
        CollectionsStore::new(PathBuf::from(input.root_path)).load()?
    } else {
        Vec::new()
    };
    let mut context = FlowExportContext {
        variables,
        ..Default::default()
    };
    for node in flow.nodes() {
        if let FlowNodeKind::Request { request_id } = &node.kind
            && let Some(saved) = find_saved_request(&collections, request_id)
        {
            let mut saved = saved.clone();
            saved.request.authentication = effective_authentication(&collections, request_id);
            context.requests.insert(
                request_id.clone(),
                FlowExportRequest {
                    request: serde_json::to_value(request_to_dto(&saved)).map_err(invalid)?,
                    variables: merge_variables(
                        &context.variables,
                        &variable_scopes(&collections, request_id),
                    ),
                },
            );
        }
    }
    let prepared = prepare_flow_export(
        serde_json::to_value(flow_to_dto(&flow)).map_err(invalid)?,
        &context,
        inline,
    )
    .map_err(invalid)?;
    // Reuse native validation for every generated node, edge, request and form.
    let output: FlowInput =
        serde_json::from_value(prepared.document["flow"].clone()).map_err(invalid)?;
    flow_from_input(output)?;
    Ok(prepared)
}

#[tauri::command]
pub async fn preview_flow_export(input: FlowExportInput) -> Result<FlowExportPreview, FlowsError> {
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare(input, false)?;
        Ok(FlowExportPreview {
            request_count: prepared.request_count,
            variable_count: prepared.variable_names.len(),
            empty_variable_count: prepared.empty_variable_names.len(),
            can_inline: prepared.blockers.is_empty(),
            has_dependencies: prepared.request_count > 0
                || !prepared.variable_names.is_empty()
                || !prepared.blockers.is_empty(),
        })
    })
    .await
    .map_err(|e| FlowsError::Storage {
        message: e.to_string(),
    })?
}

#[tauri::command]
pub async fn export_flow(
    input: WriteFlowExportInput,
    usage: tauri::State<'_, alcy_app::UsageHub>,
) -> Result<(), FlowsError> {
    let result = tauri::async_runtime::spawn_blocking(move || write_export(input))
        .await
        .map_err(|e| FlowsError::Storage {
            message: e.to_string(),
        })?;
    super::usage_events::record_export(&usage, "flow", &result);
    crate::logging::logged("alcy::export", "export flow", result)
}

fn write_export(input: WriteFlowExportInput) -> Result<(), FlowsError> {
    let path = PathBuf::from(input.path);
    if !path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("json"))
    {
        return Err(invalid("Flow exports must use the .json extension"));
    }
    let prepared = prepare(input.source, input.inline)?;
    let bytes = serde_json::to_vec_pretty(&prepared.document).map_err(invalid)?;
    std::fs::write(path, bytes).map_err(|e| FlowsError::Storage {
        message: e.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{
        Authentication, Collection, Endpoint, ProtocolId, Request, RequestDocument, SavedRequest,
    };
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn input(root: &std::path::Path) -> FlowExportInput {
        serde_json::from_value(json!({
            "rootPath":root.to_string_lossy(), "environmentVariables":[],
            "flow":{"id":"flow","name":"Example","executionKind":"standard","createdAtMs":0,"updatedAtMs":0,
                "nodes":[{"id":"start","kind":"start","x":0,"y":0},{"id":"call","kind":"request","requestId":"saved","x":200,"y":0}],
                "edges":[{"id":"edge","sourceNodeId":"start","targetNodeId":"call"}]}
        })).unwrap()
    }

    #[test]
    fn exports_valid_embedded_requests_with_inherited_auth_and_scoped_values() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("alcy-export-flow-{nanos}"));
        std::fs::create_dir_all(&root).unwrap();
        let saved = SavedRequest::new(
            "saved",
            "Get items",
            Request::new(
                Endpoint::saved("{{host}}/items"),
                RequestDocument::new(ProtocolId::Rest, ""),
                "",
                vec![],
                Authentication::Inherit,
            ),
        )
        .unwrap();
        let collection = Collection::new("collection", "Example", vec![], vec![saved])
            .unwrap()
            .with_variables(vec![
                EnvironmentVariable::new("host", "https://example.test", false).unwrap(),
            ])
            .unwrap()
            .with_authentication(Authentication::CustomHeader {
                name: "X-Example".into(),
                value: "example".into(),
            });
        CollectionsStore::new(root.clone())
            .save(&[collection])
            .unwrap();
        let prepared = prepare(input(&root), true).unwrap();
        assert_eq!(
            prepared.document["flow"]["nodes"][1]["kind"],
            "inlineRequest"
        );
        assert_eq!(
            prepared.document["flow"]["nodes"][1]["request"]["authentication"]["type"],
            "customHeader"
        );
        let path = root.join("example.flow.alcy.json");
        write_export(WriteFlowExportInput {
            source: input(&root),
            path: path.to_string_lossy().into(),
            inline: true,
        })
        .unwrap();
        let actual: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(actual, prepared.document);
        assert_eq!(
            CollectionsStore::new(root.clone()).load().unwrap()[0].requests()[0]
                .request
                .endpoint
                .url(),
            "{{host}}/items"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_references_can_be_preserved_but_conversion_never_writes_partial_files() {
        let root = std::env::temp_dir().join(format!(
            "alcy-export-missing-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("example.json");
        assert!(
            write_export(WriteFlowExportInput {
                source: input(&root),
                path: path.to_string_lossy().into(),
                inline: true
            })
            .is_err()
        );
        assert!(!path.exists());
        write_export(WriteFlowExportInput {
            source: input(&root),
            path: path.to_string_lossy().into(),
            inline: false,
        })
        .unwrap();
        let invalid_path = root.join("example.txt");
        assert!(
            write_export(WriteFlowExportInput {
                source: input(&root),
                path: invalid_path.to_string_lossy().into(),
                inline: false
            })
            .is_err()
        );
        assert!(!invalid_path.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
