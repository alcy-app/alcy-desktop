//! Resolução de datasets persistidos no workspace para o plano de carga.
//!
//! O módulo deliberadamente só devolve linhas já interpretadas. O runner
//! `alcy-load` não conhece paths, diretórios ou arquivos do desktop.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path};
use std::sync::Arc;

use alcy_app::{LoadDatasetAssets, content_hash, parse_iteration_data};
use alcy_domain::{Flow, FlowNodeKind, LoadNodeKind};
use alcy_storage::FlowStore;
use serde::{Deserialize, Serialize};
use thiserror::Error;

const FLOW_ASSETS_DIRECTORY: &str = "alcy-flow-assets";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyLoadDatasetAssetInput {
    pub root_path: String,
    pub flow_id: String,
    pub source_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyLoadDatasetAssetOutput {
    pub asset_id: String,
    pub rows: usize,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CopyLoadDatasetAssetError {
    NotFound,
    Invalid { message: String },
    Storage { message: String },
}

#[derive(Debug, Error)]
pub enum LoadDatasetAssetError {
    #[error("Dataset '{node_id}' tem assetId inválido")]
    InvalidAssetId { node_id: String },
    #[error("Dataset '{node_id}' não tem um assetId textual")]
    InvalidConfig { node_id: String },
    #[error("asset '{asset_id}' do Dataset '{node_id}' não foi encontrado")]
    NotFound { node_id: String, asset_id: String },
    #[error("asset '{asset_id}' do Dataset '{node_id}' precisa ser arquivo regular, não symlink")]
    UnsafeFile { node_id: String, asset_id: String },
    #[error("asset '{asset_id}' do Dataset '{node_id}' não é UTF-8: {message}")]
    InvalidText {
        node_id: String,
        asset_id: String,
        message: String,
    },
    #[error("asset '{asset_id}' do Dataset '{node_id}' é inválido: {message}")]
    InvalidData {
        node_id: String,
        asset_id: String,
        message: String,
    },
}

/// Copia um CSV/JSON selecionado para o diretório do flow depois de validá-lo.
/// O nome interno é derivado do conteúdo, sem reutilizar nenhum componente do
/// caminho externo. A configuração persistida guarda somente o `assetId`.
#[tauri::command]
pub fn copy_load_dataset_asset(
    input: CopyLoadDatasetAssetInput,
) -> Result<CopyLoadDatasetAssetOutput, CopyLoadDatasetAssetError> {
    if !is_single_component(&input.flow_id) {
        return Err(CopyLoadDatasetAssetError::Invalid {
            message: "identificador de flow inválido".to_string(),
        });
    }
    let root = Path::new(&input.root_path);
    let snapshot = FlowStore::new(root.to_path_buf()).load().map_err(|error| {
        CopyLoadDatasetAssetError::Storage {
            message: error.to_string(),
        }
    })?;
    if !snapshot.flows.iter().any(|flow| flow.id == input.flow_id) {
        return Err(CopyLoadDatasetAssetError::NotFound);
    }
    let source = Path::new(&input.source_path);
    let metadata =
        fs::symlink_metadata(source).map_err(|error| CopyLoadDatasetAssetError::Invalid {
            message: error.to_string(),
        })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CopyLoadDatasetAssetError::Invalid {
            message: "o Dataset precisa ser um arquivo local regular, não um symlink".to_string(),
        });
    }
    let bytes = fs::read(source).map_err(|error| CopyLoadDatasetAssetError::Invalid {
        message: error.to_string(),
    })?;
    let text = std::str::from_utf8(&bytes).map_err(|error| CopyLoadDatasetAssetError::Invalid {
        message: format!("o Dataset precisa ser UTF-8: {error}"),
    })?;
    let data = parse_iteration_data(text).map_err(|error| CopyLoadDatasetAssetError::Invalid {
        message: error.to_string(),
    })?;
    let extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|extension| matches!(extension.as_str(), "csv" | "json"))
        .ok_or_else(|| CopyLoadDatasetAssetError::Invalid {
            message: "o Dataset precisa ter extensão .csv ou .json".to_string(),
        })?;
    let asset_id = format!("dataset-{}.{}", &content_hash(&bytes)[..16], extension);
    let directory = root.join(FLOW_ASSETS_DIRECTORY).join(&input.flow_id);
    fs::create_dir_all(&directory).map_err(|error| CopyLoadDatasetAssetError::Storage {
        message: error.to_string(),
    })?;
    let target = directory.join(&asset_id);
    if !target.exists() {
        let temporary = directory.join(format!(".{asset_id}.copying"));
        fs::write(&temporary, bytes).map_err(|error| CopyLoadDatasetAssetError::Storage {
            message: error.to_string(),
        })?;
        fs::rename(&temporary, &target).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            CopyLoadDatasetAssetError::Storage {
                message: error.to_string(),
            }
        })?;
    }
    Ok(CopyLoadDatasetAssetOutput {
        asset_id,
        rows: data.len(),
    })
}

/// Lê somente assets referenciados pelo flow e converte cada linha para o
/// formato canônico. O `assetId` é um nome de arquivo simples; componentes de
/// path, symlinks e bytes fora do limite do parser são rejeitados.
pub fn resolve_load_dataset_assets(
    root: &Path,
    flow: &Flow,
) -> Result<LoadDatasetAssets, LoadDatasetAssetError> {
    let mut assets = LoadDatasetAssets::new();
    for node in flow.nodes() {
        let FlowNodeKind::Load { node: load } = &node.kind else {
            continue;
        };
        if load.kind != LoadNodeKind::Dataset {
            continue;
        }
        let config: serde_json::Value = serde_json::from_str(&load.config).map_err(|_| {
            LoadDatasetAssetError::InvalidConfig {
                node_id: node.id.clone(),
            }
        })?;
        let Some(asset_id) = config.get("assetId") else {
            continue;
        };
        let asset_id = asset_id
            .as_str()
            .ok_or_else(|| LoadDatasetAssetError::InvalidConfig {
                node_id: node.id.clone(),
            })?;
        let asset_path = safe_asset_path(root, &flow.id, asset_id).ok_or_else(|| {
            LoadDatasetAssetError::InvalidAssetId {
                node_id: node.id.clone(),
            }
        })?;
        let metadata = fs::symlink_metadata(&asset_path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                LoadDatasetAssetError::NotFound {
                    node_id: node.id.clone(),
                    asset_id: asset_id.to_string(),
                }
            } else {
                LoadDatasetAssetError::UnsafeFile {
                    node_id: node.id.clone(),
                    asset_id: asset_id.to_string(),
                }
            }
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(LoadDatasetAssetError::UnsafeFile {
                node_id: node.id.clone(),
                asset_id: asset_id.to_string(),
            });
        }
        let bytes = fs::read(asset_path).map_err(|_| LoadDatasetAssetError::UnsafeFile {
            node_id: node.id.clone(),
            asset_id: asset_id.to_string(),
        })?;
        let text =
            std::str::from_utf8(&bytes).map_err(|error| LoadDatasetAssetError::InvalidText {
                node_id: node.id.clone(),
                asset_id: asset_id.to_string(),
                message: error.to_string(),
            })?;
        let data =
            parse_iteration_data(text).map_err(|error| LoadDatasetAssetError::InvalidData {
                node_id: node.id.clone(),
                asset_id: asset_id.to_string(),
                message: error.to_string(),
            })?;
        let rows = data
            .rows
            .into_iter()
            .map(|row| row.into_iter().collect::<BTreeMap<_, _>>())
            .collect::<Vec<_>>();
        assets.insert(asset_id.to_string(), Arc::from(rows));
    }
    Ok(assets)
}

fn safe_asset_path(root: &Path, flow_id: &str, asset_id: &str) -> Option<std::path::PathBuf> {
    let path = Path::new(asset_id);
    if asset_id.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || path.components().count() != 1
    {
        return None;
    }
    Some(root.join(FLOW_ASSETS_DIRECTORY).join(flow_id).join(path))
}

fn is_single_component(value: &str) -> bool {
    let path = Path::new(value);
    !value.is_empty()
        && !path.is_absolute()
        && path.components().count() == 1
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_external_dataset_asset_ids() {
        assert!(safe_asset_path(Path::new("/workspace"), "flow", "../data.csv").is_none());
        assert!(safe_asset_path(Path::new("/workspace"), "flow", "/tmp/data.csv").is_none());
        assert!(safe_asset_path(Path::new("/workspace"), "flow", "folder/data.csv").is_none());
        assert!(safe_asset_path(Path::new("/workspace"), "flow", "data.csv").is_some());
    }
}
