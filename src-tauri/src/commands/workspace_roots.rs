//! Workspace folders a command may act on (ADR 0081, spec 0164). Almost
//! every command takes the workspace's `rootPath` from the interface; this
//! guard refuses, before any command runs, a root that is neither a recent
//! workspace (a list only the backend writes) nor a folder the person picked
//! or dropped in this session. Code running in the WebView therefore cannot
//! point workspace commands at an arbitrary folder.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use alcy_storage::RecentWorkspacesStore;
use serde_json::{Value, json};
use tauri::ipc::{Invoke, InvokeBody};
use tauri::{Manager, Runtime};

use crate::commands::picked_paths::PickedPaths;

/// Message of the error returned for a root the guard refuses.
const UNKNOWN_ROOT_MESSAGE: &str = "this folder is not an open workspace; open it again";

/// Roots of recent workspaces, cached for the session. A root missing from
/// the cache reloads the list once (a workspace opened a moment ago); roots
/// stay known until the app closes.
pub struct WorkspaceRoots {
    recents: RecentWorkspacesStore,
    known: Mutex<HashSet<PathBuf>>,
}

impl WorkspaceRoots {
    pub fn new(recents: RecentWorkspacesStore) -> Self {
        Self {
            recents,
            known: Mutex::new(HashSet::new()),
        }
    }

    fn is_recent(&self, root: &Path) -> bool {
        let Ok(mut known) = self.known.lock() else {
            return false;
        };
        if known.contains(root) {
            return true;
        }
        if let Ok(entries) = self.recents.load() {
            known.extend(entries.into_iter().map(|entry| entry.root_path));
        }
        known.contains(root)
    }

    /// Whether a command may act on the workspace at `root`.
    pub fn allows(&self, root: &str, picked: &PickedPaths) -> bool {
        if root.is_empty() {
            return false;
        }
        let root = Path::new(root);
        self.is_recent(root) || picked.allows(root)
    }
}

/// The `rootPath` an invoke carries, as `input.rootPath` or `rootPath`.
fn invoked_root_path(body: &InvokeBody) -> Option<&Value> {
    let InvokeBody::Json(Value::Object(arguments)) = body else {
        return None;
    };
    arguments
        .get("input")
        .and_then(|input| input.get("rootPath"))
        .or_else(|| arguments.get("rootPath"))
}

/// Whether the invoke may go on: no `rootPath`, or one the guard allows. A
/// `rootPath` that is not a string is left to the command's own decoding.
fn root_allowed(body: &InvokeBody, allows: impl FnOnce(&str) -> bool) -> bool {
    match invoked_root_path(body) {
        Some(Value::String(root)) => allows(root),
        _ => true,
    }
}

/// Wraps the invoke handler: an invoke whose `rootPath` is refused is
/// rejected with an `invalid` error and never reaches its command.
pub fn guard_workspace_roots<R: Runtime>(
    handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        let webview = invoke.message.webview_ref();
        let allowed = root_allowed(invoke.message.payload(), |root| {
            match (
                webview.try_state::<WorkspaceRoots>(),
                webview.try_state::<PickedPaths>(),
            ) {
                (Some(roots), Some(picked)) => roots.allows(root, &picked),
                _ => false,
            }
        });
        if allowed {
            return handler(invoke);
        }
        log::warn!(
            target: "alcy::security",
            "refused {}: the root is not a known workspace",
            invoke.message.command()
        );
        invoke
            .resolver
            .reject(json!({ "kind": "invalid", "message": UNKNOWN_ROOT_MESSAGE }));
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_storage::RecentWorkspaceEntry;
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
            "alcy-workspace-roots-{nanos}-{}",
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn record(store: &RecentWorkspacesStore, root: &Path) {
        store
            .record(RecentWorkspaceEntry {
                root_path: root.to_path_buf(),
                name: "Workspace".into(),
            })
            .unwrap();
    }

    #[test]
    fn allows_recent_workspaces_and_picked_folders_only() {
        let base = temp_root();
        let store = RecentWorkspacesStore::new(base.join("recent-workspaces.json"));
        let recent = base.join("recent");
        let picked_folder = base.join("picked");
        let other = base.join("other");
        for folder in [&recent, &picked_folder, &other] {
            fs::create_dir_all(folder).unwrap();
        }
        record(&store, &recent);
        let roots = WorkspaceRoots::new(store);
        let picked = PickedPaths::default();
        picked.record(&picked_folder);

        assert!(roots.allows(&recent.to_string_lossy(), &picked));
        assert!(roots.allows(&picked_folder.to_string_lossy(), &picked));
        assert!(!roots.allows(&other.to_string_lossy(), &picked));
        assert!(!roots.allows("", &picked));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn sees_a_workspace_recorded_after_the_cache_was_filled() {
        let base = temp_root();
        let store = RecentWorkspacesStore::new(base.join("recent-workspaces.json"));
        let first = base.join("first");
        let second = base.join("second");
        record(&store, &first);
        let roots = WorkspaceRoots::new(store.clone());
        let picked = PickedPaths::default();
        assert!(roots.allows(&first.to_string_lossy(), &picked));

        record(&store, &second);

        assert!(roots.allows(&second.to_string_lossy(), &picked));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn reads_the_root_from_the_input_or_the_top_level() {
        let nested = InvokeBody::Json(json!({ "input": { "rootPath": "/ws", "id": "x" } }));
        let top = InvokeBody::Json(json!({ "rootPath": "/ws" }));
        let none = InvokeBody::Json(json!({ "input": { "path": "/x" } }));

        assert_eq!(invoked_root_path(&nested), Some(&json!("/ws")));
        assert_eq!(invoked_root_path(&top), Some(&json!("/ws")));
        assert_eq!(invoked_root_path(&none), None);
        assert_eq!(invoked_root_path(&InvokeBody::Raw(vec![1, 2])), None);
    }

    #[test]
    fn only_string_roots_are_checked() {
        let refused = |_: &str| false;

        assert!(!root_allowed(
            &InvokeBody::Json(json!({ "input": { "rootPath": "/elsewhere" } })),
            refused
        ));
        assert!(root_allowed(
            &InvokeBody::Json(json!({ "input": { "name": "x" } })),
            refused
        ));
        assert!(root_allowed(
            &InvokeBody::Json(json!({ "input": { "rootPath": 7 } })),
            refused
        ));
    }
}
