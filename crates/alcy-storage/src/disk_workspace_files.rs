use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

use alcy_app::WorkspaceFiles;

/// Arquivos da raiz de um workspace no disco, com escrita atômica (arquivo
/// temporário + rename). Só aceita nomes simples, sem separadores de caminho.
pub struct DiskWorkspaceFiles {
    root: PathBuf,
}

impl DiskWorkspaceFiles {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn path_of(&self, name: &str) -> Result<PathBuf, String> {
        let is_plain =
            !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\']);
        if is_plain {
            Ok(self.root.join(name))
        } else {
            Err(format!("nome de arquivo inválido: {name}"))
        }
    }
}

impl WorkspaceFiles for DiskWorkspaceFiles {
    fn read(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        match fs::read(self.path_of(name)?) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn write(&self, name: &str, content: &[u8]) -> Result<(), String> {
        let path = self.path_of(name)?;
        let tmp_path = path.with_extension("tmp");
        fs::write(&tmp_path, content).map_err(|error| error.to_string())?;
        fs::rename(&tmp_path, &path).map_err(|error| error.to_string())
    }

    fn delete(&self, name: &str) -> Result<(), String> {
        match fs::remove_file(self.path_of(name)?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("alcy-disk-files-test-{nanos}-{count}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn reads_writes_and_deletes_files() {
        let root = temp_root();
        let files = DiskWorkspaceFiles::new(root.clone());

        assert_eq!(files.read("a.json").unwrap(), None);
        files.write("a.json", b"{}").unwrap();
        assert_eq!(files.read("a.json").unwrap(), Some(b"{}".to_vec()));
        assert!(!root.join("a.tmp").exists());

        files.delete("a.json").unwrap();
        files.delete("a.json").unwrap();
        assert_eq!(files.read("a.json").unwrap(), None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_names_that_escape_the_root() {
        let root = temp_root();
        let files = DiskWorkspaceFiles::new(root.clone());

        for name in ["", "..", "../fora.json", "a/b.json", "a\\b.json"] {
            assert!(files.read(name).is_err(), "{name}");
            assert!(files.write(name, b"x").is_err(), "{name}");
            assert!(files.delete(name).is_err(), "{name}");
        }
        let _ = fs::remove_dir_all(root);
    }
}
