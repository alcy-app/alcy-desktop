//! Files and folders the person handed to the app in this session (ADR 0081,
//! spec 0164): chosen in a native open dialog the backend opened, or dropped
//! on the window. Commands that read a user file the person points at accept
//! only these, so code running in the WebView cannot read arbitrary files by
//! inventing a path.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;
use tauri::{DragDropEvent, Manager, Runtime, Window, WindowEvent};
use tauri_plugin_dialog::{DialogExt, FilePath};

/// How many picks are remembered; the oldest is forgotten first.
const MAX_PICKED_PATHS: usize = 256;

/// Canonical paths picked in this session. A folder covers everything
/// inside it, after symlinks are resolved.
#[derive(Default)]
pub struct PickedPaths {
    paths: Mutex<VecDeque<PathBuf>>,
}

impl PickedPaths {
    pub fn record(&self, path: &Path) {
        let Ok(canonical) = std::fs::canonicalize(path) else {
            return;
        };
        let Ok(mut paths) = self.paths.lock() else {
            return;
        };
        paths.retain(|picked| picked != &canonical);
        if paths.len() >= MAX_PICKED_PATHS {
            paths.pop_front();
        }
        paths.push_back(canonical);
    }

    /// Whether `path` is, or lies inside, something picked in this session.
    /// A path that does not exist is never allowed.
    pub fn allows(&self, path: &Path) -> bool {
        let Ok(canonical) = std::fs::canonicalize(path) else {
            return false;
        };
        self.paths
            .lock()
            .is_ok_and(|paths| paths.iter().any(|picked| canonical.starts_with(picked)))
    }
}

/// Message of the error a command returns for a path not picked here.
pub const NOT_PICKED_MESSAGE: &str = "this file was not chosen in this session; choose it again";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickFilterInput {
    pub name: String,
    pub extensions: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickPathsInput {
    /// Pick folders instead of files.
    #[serde(default)]
    pub directory: bool,
    #[serde(default)]
    pub multiple: bool,
    #[serde(default)]
    pub filters: Vec<PickFilterInput>,
}

/// Opens the native open dialog and records what the person picks. Returns
/// the picked paths (empty when cancelled); paths that are not valid
/// Unicode are left out because the interface cannot carry them.
#[tauri::command]
pub async fn pick_paths(
    input: PickPathsInput,
    window: tauri::WebviewWindow,
    picked: tauri::State<'_, PickedPaths>,
) -> Result<Vec<String>, ()> {
    let mut dialog = window.dialog().file().set_parent(&window);
    for filter in &input.filters {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }
    let (sender, receiver) = tokio::sync::oneshot::channel::<Vec<FilePath>>();
    match (input.directory, input.multiple) {
        (true, false) => dialog.pick_folder(move |path| {
            let _ = sender.send(path.into_iter().collect());
        }),
        (true, true) => dialog.pick_folders(move |paths| {
            let _ = sender.send(paths.unwrap_or_default());
        }),
        (false, false) => dialog.pick_file(move |path| {
            let _ = sender.send(path.into_iter().collect());
        }),
        (false, true) => dialog.pick_files(move |paths| {
            let _ = sender.send(paths.unwrap_or_default());
        }),
    }
    let chosen = receiver.await.unwrap_or_default();
    let mut result = Vec::with_capacity(chosen.len());
    for path in chosen.into_iter().filter_map(|path| path.into_path().ok()) {
        picked.record(&path);
        if let Ok(text) = path.into_os_string().into_string() {
            result.push(text);
        }
    }
    Ok(result)
}

/// Records files and folders dropped on a window. The event comes from the
/// native window, not from the WebView, so a script cannot forge it.
pub fn record_dropped_paths<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
        let picked = window.state::<PickedPaths>();
        for path in paths {
            picked.record(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let root = std::env::temp_dir().join(format!(
            "alcy-picked-paths-{nanos}-{}",
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn allows_only_picked_files() {
        let root = temp_root();
        let picked_file = root.join("picked.json");
        let other_file = root.join("other.json");
        fs::write(&picked_file, "{}").unwrap();
        fs::write(&other_file, "{}").unwrap();
        let picked = PickedPaths::default();

        picked.record(&picked_file);

        assert!(picked.allows(&picked_file));
        assert!(!picked.allows(&other_file));
        assert!(!picked.allows(&root));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_picked_folder_covers_what_is_inside_it() {
        let root = temp_root();
        let folder = root.join("collections");
        fs::create_dir_all(folder.join("nested")).unwrap();
        let inside = folder.join("nested").join("api.json");
        let outside = root.join("outside.json");
        fs::write(&inside, "{}").unwrap();
        fs::write(&outside, "{}").unwrap();
        let picked = PickedPaths::default();

        picked.record(&folder);

        assert!(picked.allows(&inside));
        assert!(picked.allows(&folder));
        assert!(!picked.allows(&outside));
        assert!(!picked.allows(&folder.join("..").join("outside.json")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_paths_are_never_allowed() {
        let root = temp_root();
        let picked = PickedPaths::default();
        picked.record(&root);

        assert!(!picked.allows(&root.join("missing.json")));
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_inside_a_picked_folder_pointing_outside_is_not_allowed() {
        let root = temp_root();
        let folder = root.join("picked");
        fs::create_dir_all(&folder).unwrap();
        let target = root.join("elsewhere.txt");
        fs::write(&target, "x").unwrap();
        std::os::unix::fs::symlink(&target, folder.join("link.txt")).unwrap();
        let picked = PickedPaths::default();

        picked.record(&folder);

        assert!(!picked.allows(&folder.join("link.txt")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn forgets_the_oldest_pick_past_the_cap() {
        let root = temp_root();
        let picked = PickedPaths::default();
        let first = root.join("0.json");
        fs::write(&first, "{}").unwrap();
        picked.record(&first);
        for index in 1..=MAX_PICKED_PATHS {
            let path = root.join(format!("{index}.json"));
            fs::write(&path, "{}").unwrap();
            picked.record(&path);
        }

        assert!(!picked.allows(&first));
        assert!(picked.allows(&root.join(format!("{MAX_PICKED_PATHS}.json"))));
        let _ = fs::remove_dir_all(&root);
    }
}
