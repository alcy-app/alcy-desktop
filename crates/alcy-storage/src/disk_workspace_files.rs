use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use alcy_app::WorkspaceFiles;
use alcy_domain::is_versioned_folder_file;

/// Workspace files on disk, with atomic writes (temporary file and rename):
/// plain names at the root, and `folder/…/file` paths inside the versioned
/// folders. A symbolic link on the way is refused, so nothing is read or
/// written outside the workspace.
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
            return Ok(self.root.join(name));
        }
        if !is_versioned_folder_file(name) {
            return Err(format!("invalid file name: {name}"));
        }
        let mut path = self.root.clone();
        for component in name.split('/') {
            path.push(component);
            if is_symlink(&path) {
                return Err(format!("{name} goes through a symbolic link"));
            }
        }
        Ok(path)
    }

    /// Removes the folders a deletion left empty, up to the versioned folder.
    fn prune_empty_parents(&self, name: &str) {
        let mut components: Vec<&str> = name.split('/').collect();
        components.pop();
        while components.len() > 1 {
            let folder = components
                .iter()
                .fold(self.root.clone(), |path, component| path.join(component));
            if fs::remove_dir(folder).is_err() {
                return;
            }
            components.pop();
        }
    }

    /// Modification time and size of a root file, to notice that it changed
    /// without reading it. `None` while the file does not exist.
    pub fn stamp(&self, name: &str) -> Result<Option<String>, String> {
        let metadata = match fs::metadata(self.path_of(name)?) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        let modified = metadata
            .modified()
            .map_err(|error| error.to_string())?
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        Ok(Some(format!("{modified}:{}", metadata.len())))
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
        if name.contains('/')
            && let Some(parent) = path.parent()
        {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let tmp_path = path.with_extension("tmp");
        fs::write(&tmp_path, content).map_err(|error| error.to_string())?;
        fs::rename(&tmp_path, &path).map_err(|error| error.to_string())
    }

    fn delete(&self, name: &str) -> Result<(), String> {
        match fs::remove_file(self.path_of(name)?) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        if name.contains('/') {
            self.prune_empty_parents(name);
        }
        Ok(())
    }

    fn list(&self, folder: &str) -> Result<Vec<String>, String> {
        let path = self.root.join(folder);
        let mut names = Vec::new();
        if folder.contains(['/', '\\']) || !path.is_dir() || is_symlink(&path) {
            return Ok(names);
        }
        collect_files(&path, folder, &mut names)?;
        names.retain(|name| is_versioned_folder_file(name));
        names.sort();
        Ok(names)
    }
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink())
}

/// Regular files under `dir`, named `prefix/…`; symbolic links are skipped.
fn collect_files(dir: &Path, prefix: &str, names: &mut Vec<String>) -> Result<(), String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let Some(file_name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let name = format!("{prefix}/{file_name}");
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_dir() {
            collect_files(&entry.path(), &name, names)?;
        } else if file_type.is_file() {
            names.push(name);
        }
    }
    Ok(())
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
    fn files_inside_versioned_folders_are_listed_written_and_pruned() {
        let root = temp_root();
        let files = DiskWorkspaceFiles::new(root.clone());
        let name = "alcy-documents/doc-1/assets/image.png";

        assert_eq!(files.list("alcy-documents").unwrap(), Vec::<String>::new());
        files.write(name, b"png").unwrap();
        files
            .write("alcy-documents/doc-1/document.json", b"{}")
            .unwrap();
        fs::write(root.join("alcy-documents/doc-1/.draft"), "x").unwrap();
        fs::write(root.join("alcy-documents/doc-1/document.tmp"), "x").unwrap();
        assert_eq!(files.read(name).unwrap(), Some(b"png".to_vec()));
        assert_eq!(
            files.list("alcy-documents").unwrap(),
            [
                "alcy-documents/doc-1/assets/image.png",
                "alcy-documents/doc-1/document.json"
            ]
        );
        assert!(files.write("alcy-history/entry.json", b"{}").is_err());
        assert!(files.write("alcy-documents/../escape.json", b"{}").is_err());

        files.delete(name).unwrap();
        assert!(!root.join("alcy-documents/doc-1/assets").exists());
        assert!(root.join("alcy-documents/doc-1").is_dir());
        fs::remove_dir_all(root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_links_inside_versioned_folders_are_refused() {
        let root = temp_root();
        let outside = temp_root();
        fs::create_dir_all(root.join("alcy-flow-assets")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("alcy-flow-assets/flow-1")).unwrap();
        let files = DiskWorkspaceFiles::new(root.clone());

        assert!(
            files
                .write("alcy-flow-assets/flow-1/data.csv", b"x")
                .is_err()
        );
        assert!(files.read("alcy-flow-assets/flow-1/data.csv").is_err());
        assert_eq!(
            files.list("alcy-flow-assets").unwrap(),
            Vec::<String>::new()
        );
        assert!(!outside.join("data.csv").exists());
        fs::remove_dir_all(root).ok();
        fs::remove_dir_all(outside).ok();
    }

    #[test]
    fn stamps_change_with_the_file_and_are_absent_without_it() {
        let root = temp_root();
        let files = DiskWorkspaceFiles::new(root.clone());
        assert_eq!(files.stamp("a.json"), Ok(None));

        files.write("a.json", b"1").unwrap();
        let first = files.stamp("a.json").unwrap();
        files.write("a.json", b"22").unwrap();
        let second = files.stamp("a.json").unwrap();

        fs::remove_dir_all(&root).ok();

        assert!(first.is_some());
        assert_ne!(first, second);
        assert!(files.stamp("../a.json").is_err());
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
