use std::path::PathBuf;

use alcy_app::preview_load_flow_with_datasets as build_preview;
use alcy_storage::FlowStore;
use serde::{Deserialize, Serialize};

use crate::commands::load_dataset_assets::resolve_load_dataset_assets;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewLoadFlowInput {
    pub root_path: String,
    pub flow_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadScenarioPreviewDto {
    pub node_id: String,
    pub label: String,
    pub peak_vus: u32,
    pub duration_ms: Option<u64>,
    pub peak_arrival_rate_per_second: Option<f64>,
    pub request_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadFlowPreviewDto {
    pub scenarios: Vec<LoadScenarioPreviewDto>,
    pub destinations: Vec<String>,
    pub peak_vus: u32,
    pub duration_ms: Option<u64>,
    pub peak_arrival_rate_per_second: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PreviewLoadFlowError {
    NotFound,
    Invalid { message: String },
    Storage { message: String },
}

#[tauri::command]
pub fn preview_load_flow(
    input: PreviewLoadFlowInput,
) -> Result<LoadFlowPreviewDto, PreviewLoadFlowError> {
    let root = PathBuf::from(input.root_path);
    let snapshot =
        FlowStore::new(root.clone())
            .load()
            .map_err(|error| PreviewLoadFlowError::Storage {
                message: error.to_string(),
            })?;
    let flow = snapshot
        .flows
        .iter()
        .find(|flow| flow.id == input.flow_id)
        .ok_or(PreviewLoadFlowError::NotFound)?;
    let datasets = resolve_load_dataset_assets(&root, flow).map_err(|error| {
        PreviewLoadFlowError::Invalid {
            message: error.to_string(),
        }
    })?;
    let preview =
        build_preview(flow, &datasets).map_err(|error| PreviewLoadFlowError::Invalid {
            message: error.to_string(),
        })?;
    Ok(LoadFlowPreviewDto {
        scenarios: preview
            .scenarios
            .into_iter()
            .map(|scenario| LoadScenarioPreviewDto {
                node_id: scenario.node_id,
                label: scenario.label,
                peak_vus: scenario.peak_vus,
                duration_ms: scenario.duration_ms,
                peak_arrival_rate_per_second: scenario.peak_arrival_rate_per_second,
                request_count: scenario.request_count,
            })
            .collect(),
        destinations: preview.destinations,
        peak_vus: preview.peak_vus,
        duration_ms: preview.duration_ms,
        peak_arrival_rate_per_second: preview.peak_arrival_rate_per_second,
    })
}
