use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::storage_error::StorageError;

const CURRENT_VERSION: u32 = 1;
const MAX_RECENT_WORKSPACES: usize = 10;

/// Um ponteiro leve para um workspace já aberto antes — só o necessário
/// para reabri-lo e mostrar um rótulo, sem precisar ler o manifesto de
/// volta.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecentWorkspaceEntry {
    pub root_path: PathBuf,
    pub name: String,
}

#[derive(Serialize, Deserialize)]
struct PersistedFile {
    version: u32,
    entries: Vec<RecentWorkspaceEntry>,
}

impl Default for PersistedFile {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            entries: Vec::new(),
        }
    }
}

/// Lê e grava a lista de workspaces abertos recentemente, mais recente
/// primeiro, limitada a `MAX_RECENT_WORKSPACES` entradas.
#[derive(Clone)]
pub struct RecentWorkspacesStore {
    path: PathBuf,
}

impl RecentWorkspacesStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn load(&self) -> Result<Vec<RecentWorkspaceEntry>, StorageError> {
        Ok(self.load_file()?.entries)
    }

    /// Registra `entry` como o workspace aberto mais recentemente:
    /// remove qualquer entrada existente com o mesmo `root_path`, insere
    /// `entry` no início, trunca em `MAX_RECENT_WORKSPACES` e persiste.
    pub fn record(
        &self,
        entry: RecentWorkspaceEntry,
    ) -> Result<Vec<RecentWorkspaceEntry>, StorageError> {
        let mut entries = self.load()?;
        entries.retain(|existing| existing.root_path != entry.root_path);
        entries.insert(0, entry);
        entries.truncate(MAX_RECENT_WORKSPACES);

        self.write_file(&PersistedFile {
            version: CURRENT_VERSION,
            entries: entries.clone(),
        })?;

        Ok(entries)
    }

    /// Esquece o workspace em `root_path`: remove sua entrada da lista,
    /// se presente, e persiste. Não toca nos arquivos do workspace em
    /// disco — apenas deixa de listá-lo entre os recentes.
    pub fn remove(
        &self,
        root_path: &std::path::Path,
    ) -> Result<Vec<RecentWorkspaceEntry>, StorageError> {
        let mut entries = self.load()?;
        entries.retain(|existing| existing.root_path != root_path);

        self.write_file(&PersistedFile {
            version: CURRENT_VERSION,
            entries: entries.clone(),
        })?;

        Ok(entries)
    }

    /// Atualiza o nome exibido da entrada em `root_path`, mantendo sua
    /// posição na lista (renomear não conta como abrir). Sem efeito se o
    /// workspace não estiver entre os recentes.
    pub fn rename(
        &self,
        root_path: &std::path::Path,
        name: &str,
    ) -> Result<Vec<RecentWorkspaceEntry>, StorageError> {
        let mut entries = self.load()?;
        let Some(entry) = entries
            .iter_mut()
            .find(|existing| existing.root_path == root_path)
        else {
            return Ok(entries);
        };
        entry.name = name.to_string();

        self.write_file(&PersistedFile {
            version: CURRENT_VERSION,
            entries: entries.clone(),
        })?;

        Ok(entries)
    }

    /// Points the entry at `from` to `to`, keeping its position. An entry
    /// already at `to` is stale (its folder was gone, or the rename would not
    /// have been possible) and is dropped so the list has no duplicate.
    pub fn relocate(
        &self,
        from: &std::path::Path,
        to: &std::path::Path,
    ) -> Result<Vec<RecentWorkspaceEntry>, StorageError> {
        let mut entries = self.load()?;
        entries.retain(|existing| existing.root_path != to);
        let Some(entry) = entries
            .iter_mut()
            .find(|existing| existing.root_path == from)
        else {
            return Ok(entries);
        };
        entry.root_path = to.to_path_buf();

        self.write_file(&PersistedFile {
            version: CURRENT_VERSION,
            entries: entries.clone(),
        })?;

        Ok(entries)
    }

    fn load_file(&self) -> Result<PersistedFile, StorageError> {
        if !self.path.exists() {
            return Ok(PersistedFile::default());
        }

        let raw = fs::read_to_string(&self.path)
            .map_err(|error| StorageError::Read(error.to_string()))?;
        let file: PersistedFile = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;

        if file.version != CURRENT_VERSION {
            return Err(StorageError::UnsupportedVersion(file.version));
        }

        Ok(file)
    }

    fn write_file(&self, file: &PersistedFile) -> Result<(), StorageError> {
        let json = serde_json::to_string_pretty(file)
            .map_err(|error| StorageError::Write(error.to_string()))?;

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| StorageError::Write(error.to_string()))?;
        }

        let tmp_path = self.path.with_extension("tmp");
        fs::write(&tmp_path, json).map_err(|error| StorageError::Write(error.to_string()))?;
        fs::rename(&tmp_path, &self.path)
            .map_err(|error| StorageError::Write(error.to_string()))?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_path() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("alcy-recent-workspaces-test-{nanos}-{count}.json"))
    }

    fn entry(root: &str, name: &str) -> RecentWorkspaceEntry {
        RecentWorkspaceEntry {
            root_path: PathBuf::from(root),
            name: name.to_string(),
        }
    }

    #[test]
    fn load_returns_an_empty_list_when_the_file_does_not_exist() {
        let store = RecentWorkspacesStore::new(temp_path());

        assert_eq!(store.load().unwrap(), vec![]);
    }

    #[test]
    fn record_adds_an_entry_to_an_empty_list() {
        let path = temp_path();
        let store = RecentWorkspacesStore::new(path.clone());

        let entries = store.record(entry("/workspaces/a", "A")).unwrap();

        assert_eq!(entries, vec![entry("/workspaces/a", "A")]);
        assert_eq!(store.load().unwrap(), vec![entry("/workspaces/a", "A")]);

        fs::remove_file(&path).ok();
    }

    #[test]
    fn record_moves_an_existing_entry_to_the_front_and_updates_its_name() {
        let path = temp_path();
        let store = RecentWorkspacesStore::new(path.clone());

        store.record(entry("/workspaces/a", "A")).unwrap();
        store.record(entry("/workspaces/b", "B")).unwrap();
        let entries = store.record(entry("/workspaces/a", "A renamed")).unwrap();

        assert_eq!(
            entries,
            vec![
                entry("/workspaces/a", "A renamed"),
                entry("/workspaces/b", "B")
            ]
        );

        fs::remove_file(&path).ok();
    }

    #[test]
    fn record_truncates_beyond_the_limit() {
        let path = temp_path();
        let store = RecentWorkspacesStore::new(path.clone());

        for index in 0..(MAX_RECENT_WORKSPACES + 1) {
            store
                .record(entry(&format!("/workspaces/{index}"), "W"))
                .unwrap();
        }

        let entries = store.load().unwrap();

        assert_eq!(entries.len(), MAX_RECENT_WORKSPACES);
        assert_eq!(
            entries[0],
            entry(&format!("/workspaces/{MAX_RECENT_WORKSPACES}"), "W")
        );

        fs::remove_file(&path).ok();
    }

    #[test]
    fn load_fails_with_corrupted_for_invalid_json() {
        let path = temp_path();
        fs::write(&path, "not json").unwrap();
        let store = RecentWorkspacesStore::new(path.clone());

        let error = store.load().unwrap_err();

        assert!(matches!(error, StorageError::Corrupted(_)));

        fs::remove_file(&path).ok();
    }

    #[test]
    fn load_fails_with_unsupported_version_for_a_future_version() {
        let path = temp_path();
        fs::write(&path, r#"{"version": 99, "entries": []}"#).unwrap();
        let store = RecentWorkspacesStore::new(path.clone());

        let error = store.load().unwrap_err();

        assert_eq!(
            error.to_string(),
            StorageError::UnsupportedVersion(99).to_string()
        );

        fs::remove_file(&path).ok();
    }

    #[test]
    fn remove_forgets_the_matching_entry_and_keeps_the_rest() {
        let path = temp_path();
        let store = RecentWorkspacesStore::new(path.clone());

        store.record(entry("/workspaces/a", "A")).unwrap();
        store.record(entry("/workspaces/b", "B")).unwrap();
        let entries = store.remove(&PathBuf::from("/workspaces/a")).unwrap();

        assert_eq!(entries, vec![entry("/workspaces/b", "B")]);
        assert_eq!(store.load().unwrap(), vec![entry("/workspaces/b", "B")]);

        fs::remove_file(&path).ok();
    }

    #[test]
    fn remove_is_a_no_op_when_the_entry_is_not_present() {
        let path = temp_path();
        let store = RecentWorkspacesStore::new(path.clone());

        store.record(entry("/workspaces/a", "A")).unwrap();
        let entries = store.remove(&PathBuf::from("/workspaces/missing")).unwrap();

        assert_eq!(entries, vec![entry("/workspaces/a", "A")]);

        fs::remove_file(&path).ok();
    }

    #[test]
    fn rename_updates_the_name_keeping_the_position() {
        let path = temp_path();
        let store = RecentWorkspacesStore::new(path.clone());

        store.record(entry("/workspaces/a", "A")).unwrap();
        store.record(entry("/workspaces/b", "B")).unwrap();
        let entries = store
            .rename(&PathBuf::from("/workspaces/a"), "A renamed")
            .unwrap();

        let expected = vec![
            entry("/workspaces/b", "B"),
            entry("/workspaces/a", "A renamed"),
        ];
        assert_eq!(entries, expected);
        assert_eq!(store.load().unwrap(), expected);

        fs::remove_file(&path).ok();
    }

    #[test]
    fn rename_is_a_no_op_when_the_entry_is_not_present() {
        let path = temp_path();
        let store = RecentWorkspacesStore::new(path.clone());

        store.record(entry("/workspaces/a", "A")).unwrap();
        let entries = store
            .rename(&PathBuf::from("/workspaces/missing"), "Other")
            .unwrap();

        assert_eq!(entries, vec![entry("/workspaces/a", "A")]);

        fs::remove_file(&path).ok();
    }

    #[test]
    fn relocate_changes_the_path_keeping_the_position_and_the_name() {
        let path = temp_path();
        let store = RecentWorkspacesStore::new(path.clone());

        store.record(entry("/workspaces/a", "A")).unwrap();
        store.record(entry("/workspaces/b", "B")).unwrap();
        let entries = store
            .relocate(
                &PathBuf::from("/workspaces/a"),
                &PathBuf::from("/workspaces/c"),
            )
            .unwrap();

        let expected = vec![entry("/workspaces/b", "B"), entry("/workspaces/c", "A")];
        assert_eq!(entries, expected);
        assert_eq!(store.load().unwrap(), expected);

        fs::remove_file(&path).ok();
    }

    #[test]
    fn relocate_replaces_a_stale_entry_at_the_destination() {
        let path = temp_path();
        let store = RecentWorkspacesStore::new(path.clone());

        store.record(entry("/workspaces/old", "Old")).unwrap();
        store.record(entry("/workspaces/a", "A")).unwrap();
        let entries = store
            .relocate(
                &PathBuf::from("/workspaces/a"),
                &PathBuf::from("/workspaces/old"),
            )
            .unwrap();

        assert_eq!(entries, vec![entry("/workspaces/old", "A")]);

        fs::remove_file(&path).ok();
    }

    #[test]
    fn record_does_not_leave_a_temporary_file_behind() {
        let path = temp_path();
        let store = RecentWorkspacesStore::new(path.clone());

        store.record(entry("/workspaces/a", "A")).unwrap();

        assert!(!path.with_extension("tmp").exists());

        fs::remove_file(&path).ok();
    }
}
