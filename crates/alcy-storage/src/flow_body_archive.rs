//! Bounded, asynchronous capture of the last response body of each flow node.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;

use alcy_app::content_hash;
use serde::{Deserialize, Serialize};

pub const MAX_FLOW_BODY_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_FLOW_RUN_BODY_BYTES: usize = 256 * 1024 * 1024;
static CAPTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedFlowBody {
    pub revision: u64,
    pub bytes: usize,
    /// pending, available, binary, limit, busy, or unavailable.
    pub availability: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct Manifest {
    version: u32,
    entries: BTreeMap<String, ArchivedFlowBody>,
}

impl Default for Manifest {
    fn default() -> Self {
        Self {
            version: 1,
            entries: BTreeMap::new(),
        }
    }
}

struct Job {
    node: String,
    revision: u64,
    body: String,
}

struct Inner {
    directory: Mutex<PathBuf>,
    manifest: Arc<Mutex<Manifest>>,
    sender: Mutex<Option<mpsc::SyncSender<Job>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
    temporary: Mutex<bool>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.sender
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(worker) = self
            .worker
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            let _ = worker.join();
        }
        if *self.temporary.get_mut().unwrap_or_else(|e| e.into_inner()) {
            let _ = fs::remove_dir_all(self.directory.get_mut().unwrap_or_else(|e| e.into_inner()));
        }
    }
}

#[derive(Clone)]
pub struct FlowBodyCapture(Arc<Inner>);

fn node_file(node: &str) -> String {
    format!("{}.body", content_hash(node.as_bytes()))
}

pub fn flow_body_directory(root: &Path, run: &str) -> Option<PathBuf> {
    if run.is_empty()
        || run.len() > 128
        || !run
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some(root.join("alcy-flow-runs").join(format!("{run}.bodies")))
}

fn write_manifest(directory: &Path, manifest: &Manifest) -> std::io::Result<()> {
    fs::create_dir_all(directory)?;
    let bytes = serde_json::to_vec(manifest)?;
    fs::write(directory.join("manifest.tmp"), bytes)?;
    fs::rename(
        directory.join("manifest.tmp"),
        directory.join("manifest.json"),
    )
}

impl FlowBodyCapture {
    pub fn new() -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "alcy-flow-bodies-{}-{nonce}-{}",
            std::process::id(),
            CAPTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let manifest = Arc::new(Mutex::new(Manifest::default()));
        let (sender, receiver) = mpsc::sync_channel::<Job>(2);
        let worker_manifest = manifest.clone();
        let worker_directory = directory.clone();
        let worker = std::thread::spawn(move || {
            clean_abandoned_captures();
            let mut written = BTreeMap::<String, PathBuf>::new();
            while let Ok(job) = receiver.recv() {
                let (current, stale) = {
                    let manifest = worker_manifest.lock().unwrap_or_else(|e| e.into_inner());
                    let current = manifest
                        .entries
                        .get(&job.node)
                        .is_some_and(|entry| entry.revision == job.revision);
                    let stale = written
                        .keys()
                        .filter(|node| {
                            manifest
                                .entries
                                .get(*node)
                                .is_none_or(|entry| entry.availability != "available")
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    (current, stale)
                };
                for node in stale {
                    if let Some(path) = written.remove(&node) {
                        let _ = fs::remove_file(path);
                    }
                }
                if !current {
                    continue;
                }
                let file = worker_directory.join(node_file(&job.node));
                let result = fs::create_dir_all(&worker_directory)
                    .and_then(|()| fs::write(file.with_extension("tmp"), job.body.as_bytes()))
                    .and_then(|()| fs::rename(file.with_extension("tmp"), &file));
                if result.is_ok() {
                    written.insert(job.node.clone(), file);
                }
                let mut manifest = worker_manifest.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(entry) = manifest
                    .entries
                    .get_mut(&job.node)
                    .filter(|entry| entry.revision == job.revision)
                {
                    entry.availability = if result.is_ok() {
                        "available"
                    } else {
                        "unavailable"
                    }
                    .into();
                }
                // Live readers use the shared metadata; write the durable manifest only after draining.
            }
            let manifest = worker_manifest
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            if let Ok(entries) = fs::read_dir(&worker_directory) {
                let active: std::collections::HashSet<_> = manifest
                    .entries
                    .iter()
                    .filter(|(_, entry)| entry.availability == "available")
                    .map(|(node, _)| node_file(node))
                    .collect();
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.ends_with(".tmp")
                        || (name.ends_with(".body") && !active.contains(&name))
                    {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
            let _ = write_manifest(&worker_directory, &manifest);
        });
        Self(Arc::new(Inner {
            directory: Mutex::new(directory),
            manifest,
            sender: Mutex::new(Some(sender)),
            worker: Mutex::new(Some(worker)),
            temporary: Mutex::new(true),
        }))
    }

    /// Capture never waits for disk or a full queue and never changes execution outcomes.
    pub fn capture(&self, node: &str, body: &str, binary: bool) {
        let mut manifest = self.0.manifest.lock().unwrap_or_else(|e| e.into_inner());
        let previous = manifest.entries.get(node);
        let revision = previous.map_or(1, |entry| entry.revision + 1);
        let retained: usize = manifest
            .entries
            .iter()
            .filter(|(key, entry)| {
                key.as_str() != node
                    && matches!(entry.availability.as_str(), "pending" | "available")
            })
            .map(|(_, entry)| entry.bytes.min(MAX_FLOW_BODY_BYTES))
            .sum();
        let availability = if binary {
            "binary"
        } else if body.len() > MAX_FLOW_BODY_BYTES
            || retained.saturating_add(body.len()) > MAX_FLOW_RUN_BODY_BYTES
        {
            "limit"
        } else {
            "pending"
        };
        let mut entry = ArchivedFlowBody {
            revision,
            bytes: body.len(),
            availability: availability.into(),
        };
        if availability == "pending" {
            let sender = self.0.sender.lock().unwrap_or_else(|e| e.into_inner());
            if sender.as_ref().is_none_or(|sender| {
                sender
                    .try_send(Job {
                        node: node.into(),
                        revision,
                        body: body.into(),
                    })
                    .is_err()
            }) {
                entry.availability = "busy".into();
            }
        }
        manifest.entries.insert(node.into(), entry);
    }

    pub fn metadata(&self, node: &str) -> Option<ArchivedFlowBody> {
        self.0
            .manifest
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .get(node)
            .cloned()
    }

    pub fn directory(&self) -> PathBuf {
        self.0
            .directory
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Called on a blocking worker after execution, before publishing runFinished.
    pub fn finish(&self, destination: Option<PathBuf>) {
        self.0
            .sender
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(worker) = self
            .0
            .worker
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            let _ = worker.join();
        }
        let Some(destination) = destination else {
            return;
        };
        let mut directory = self.0.directory.lock().unwrap_or_else(|e| e.into_inner());
        let result = destination
            .parent()
            .map(fs::create_dir_all)
            .transpose()
            .and_then(|_| {
                if fs::rename(&*directory, &destination).is_ok() {
                    return Ok(());
                }
                fs::create_dir_all(&destination)?;
                for entry in fs::read_dir(&*directory)? {
                    let entry = entry?;
                    fs::copy(entry.path(), destination.join(entry.file_name()))?;
                }
                fs::remove_dir_all(&*directory)
            });
        if result.is_ok() {
            *directory = destination;
            *self.0.temporary.lock().unwrap_or_else(|e| e.into_inner()) = false;
        }
    }
}

impl Default for FlowBodyCapture {
    fn default() -> Self {
        Self::new()
    }
}

pub fn read_archived_flow_body(directory: &Path, node: &str) -> Option<ArchivedFlowBody> {
    let metadata = fs::metadata(directory.join("manifest.json")).ok()?;
    if metadata.len() > 4 * 1024 * 1024 {
        return None;
    }
    let manifest: Manifest =
        serde_json::from_slice(&fs::read(directory.join("manifest.json")).ok()?).ok()?;
    if manifest.version != 1 {
        return None;
    }
    manifest.entries.get(node).cloned()
}

/// Interrupted sessions never become canonical history. Remove stale captures from other processes.
fn clean_abandoned_captures() {
    let Ok(entries) = fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    let own_prefix = format!("alcy-flow-bodies-{}-", std::process::id());
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("alcy-flow-bodies-") || name.starts_with(&own_prefix) {
            continue;
        }
        let stale = entry
            .metadata()
            .ok()
            .filter(|metadata| metadata.is_dir())
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > std::time::Duration::from_secs(24 * 3600));
        if stale {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

pub fn archived_flow_body_path(directory: &Path, node: &str) -> PathBuf {
    directory.join(node_file(node))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_large_bodies_and_replaces_the_last_occurrence() {
        let capture = FlowBodyCapture::new();
        capture.capture("node/../../a", &"x".repeat(300_000), false);
        capture.finish(None);
        assert_eq!(
            capture.metadata("node/../../a").unwrap().availability,
            "available"
        );
        assert_eq!(
            fs::read(archived_flow_body_path(
                &capture.directory(),
                "node/../../a"
            ))
            .unwrap()
            .len(),
            300_000
        );
        assert!(flow_body_directory(Path::new("/tmp"), "../escape").is_none());
    }

    #[test]
    fn binary_bodies_are_not_queued() {
        let capture = FlowBodyCapture::new();
        capture.capture("node", "AAAA", true);
        capture.finish(None);
        assert_eq!(capture.metadata("node").unwrap().availability, "binary");
        assert!(!archived_flow_body_path(&capture.directory(), "node").exists());
    }
}
