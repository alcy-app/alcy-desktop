//! A merge waiting for conflict resolution, kept in `.git/alcy-merge.json`.

use std::path::{Path, PathBuf};

use alcy_app::RemoteError;
use gix::ObjectId;
use serde::{Deserialize, Serialize};

use crate::rejected;

const FILE_NAME: &str = "alcy-merge.json";
const VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MergeState {
    /// Commit being merged into the current branch.
    pub theirs: ObjectId,
    /// Who or what is being merged (a person or a branch name).
    pub label: String,
    /// Tree served as "remote" while the merge is pending: merged files plus
    /// their side of every conflicted file.
    pub merge_tree: ObjectId,
    /// Files written on disk by the merge (restored on cancel).
    pub files: Vec<String>,
    pub conflicts: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Persisted {
    version: u32,
    theirs: String,
    label: String,
    merge_tree: String,
    files: Vec<String>,
    conflicts: Vec<String>,
}

fn path(git_dir: &Path) -> PathBuf {
    git_dir.join(FILE_NAME)
}

fn object_id(hex: &str) -> Result<ObjectId, RemoteError> {
    ObjectId::from_hex(hex.as_bytes()).map_err(rejected)
}

impl MergeState {
    pub fn load(git_dir: &Path) -> Result<Option<Self>, RemoteError> {
        let path = path(git_dir);
        if !path.exists() {
            return Ok(None);
        }
        let raw = std::fs::read_to_string(&path).map_err(rejected)?;
        let persisted: Persisted = serde_json::from_str(&raw).map_err(rejected)?;
        if persisted.version != VERSION {
            return Err(rejected(format!(
                "unsupported merge state version {}",
                persisted.version
            )));
        }
        Ok(Some(Self {
            theirs: object_id(&persisted.theirs)?,
            label: persisted.label,
            merge_tree: object_id(&persisted.merge_tree)?,
            files: persisted.files,
            conflicts: persisted.conflicts,
        }))
    }

    pub fn save(&self, git_dir: &Path) -> Result<(), RemoteError> {
        let json = serde_json::to_string_pretty(&Persisted {
            version: VERSION,
            theirs: self.theirs.to_string(),
            label: self.label.clone(),
            merge_tree: self.merge_tree.to_string(),
            files: self.files.clone(),
            conflicts: self.conflicts.clone(),
        })
        .map_err(rejected)?;
        let path = path(git_dir);
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, json).map_err(rejected)?;
        std::fs::rename(&tmp, &path).map_err(rejected)
    }

    pub fn clear(git_dir: &Path) -> Result<(), RemoteError> {
        match std::fs::remove_file(path(git_dir)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(rejected(error)),
        }
    }
}
