use std::fs;
use std::path::PathBuf;

use crate::storage_error::StorageError;

/// Id of this installation in shared git folders (ADR 0074): the name of the
/// refs only it writes, `refs/heads/alcy/<id>/<branch>`. Created once and
/// kept in `app_data_dir`, so renaming the git user does not change it.
pub struct GitPeerStore {
    path: PathBuf,
}

/// A ref path component: lowercase letters, digits and dashes.
fn valid(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('-')
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

impl GitPeerStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// The saved id, or `create()`'s result saved for next time.
    pub fn load_or_create(&self, create: impl FnOnce() -> String) -> Result<String, StorageError> {
        if self.path.exists() {
            let id = fs::read_to_string(&self.path)
                .map_err(|error| StorageError::Read(error.to_string()))?;
            let id = id.trim();
            if !valid(id) {
                return Err(StorageError::Corrupted("invalid git peer id".to_string()));
            }
            return Ok(id.to_string());
        }
        let id = create();
        if !valid(&id) {
            return Err(StorageError::Write("invalid git peer id".to_string()));
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| StorageError::Write(error.to_string()))?;
        }
        let tmp = self.path.with_extension("tmp");
        fs::write(&tmp, &id).map_err(|error| StorageError::Write(error.to_string()))?;
        fs::rename(&tmp, &self.path).map_err(|error| StorageError::Write(error.to_string()))?;
        Ok(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_the_id_once() {
        let dir = std::env::temp_dir().join(format!("alcy-git-peer-test-{}", std::process::id()));
        let store = GitPeerStore::new(dir.join("git-peer-id"));
        assert_eq!(
            store.load_or_create(|| "ana-1a2b".into()).unwrap(),
            "ana-1a2b"
        );
        assert_eq!(store.load_or_create(|| "other".into()).unwrap(), "ana-1a2b");

        fs::write(dir.join("git-peer-id"), "../x").unwrap();
        assert!(matches!(
            store.load_or_create(|| "x".into()),
            Err(StorageError::Corrupted(_))
        ));
        let fresh = GitPeerStore::new(dir.join("other"));
        assert!(fresh.load_or_create(|| "Bad Id".into()).is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
