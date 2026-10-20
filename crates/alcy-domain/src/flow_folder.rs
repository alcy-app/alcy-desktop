use std::collections::HashSet;

use thiserror::Error;

use crate::Flow;

/// Workspace organization, independent of graph execution and run history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowFolder {
    pub id: String,
    pub name: String,
    pub flow_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("Invalid flow folders: {0}")]
pub struct FlowFoldersError(pub &'static str);

pub fn validate_flow_folders(
    flows: &[Flow],
    folders: &[FlowFolder],
) -> Result<(), FlowFoldersError> {
    let flow_ids: HashSet<_> = flows.iter().map(|flow| flow.id.as_str()).collect();
    if flow_ids.len() != flows.len() {
        return Err(FlowFoldersError("duplicate flow ID"));
    }
    let mut folder_ids = HashSet::new();
    let mut assigned = HashSet::new();
    for folder in folders {
        if folder.id.trim().is_empty() || folder.name.trim().is_empty() {
            return Err(FlowFoldersError("folder ID and name must not be empty"));
        }
        if !folder_ids.insert(folder.id.as_str()) {
            return Err(FlowFoldersError("duplicate folder ID"));
        }
        for id in &folder.flow_ids {
            if !flow_ids.contains(id.as_str()) {
                return Err(FlowFoldersError("folder references a missing flow"));
            }
            if !assigned.insert(id.as_str()) {
                return Err(FlowFoldersError("a flow can belong to only one folder"));
            }
        }
    }
    Ok(())
}
