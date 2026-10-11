use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::storage_error::StorageError;

const CURRENT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct PersistedSchema {
    version: u32,
    schema: Value,
}

/// Cache descartável de schemas GraphQL introspectados, por URL de
/// endpoint já resolvida, persistido em disco entre reinícios do app.
///
/// Um arquivo por endpoint (nome derivado de um hash da URL) dentro do
/// diretório passado a `new`, em vez de um único arquivo com todos os
/// schemas: `get`/`save` tocam só o arquivo do endpoint em questão, então o
/// custo não cresce com o número de endpoints já cacheados.
///
/// Guarda o schema como `serde_json::Value` opaco — este crate não conhece
/// o tipo `GraphqlSchema` nem o protocolo GraphQL, só persiste o que a
/// camada GraphQL-específica (`src-tauri`) já serializou. Não é dado
/// canônico: perder ou invalidar um desses arquivos nunca corrompe nada, o
/// próximo carregamento simplesmente busca de novo via introspection.
///
/// `Clone` é barato (só um `PathBuf`) — usado para mover uma cópia para
/// dentro de um closure `'static` de `spawn_blocking` sem afetar a
/// instância gerenciada pelo Tauri (`tauri::State`).
#[derive(Clone)]
pub struct SchemaStore {
    dir: PathBuf,
}

impl SchemaStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn get(&self, endpoint_url: &str) -> Result<Option<Value>, StorageError> {
        let path = self.entry_path(endpoint_url);
        if !path.exists() {
            return Ok(None);
        }

        let raw =
            fs::read_to_string(&path).map_err(|error| StorageError::Read(error.to_string()))?;
        let persisted: PersistedSchema = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;

        if persisted.version != CURRENT_VERSION {
            return Err(StorageError::UnsupportedVersion(persisted.version));
        }

        Ok(Some(persisted.schema))
    }

    pub fn save(&self, endpoint_url: &str, schema: Value) -> Result<(), StorageError> {
        let persisted = PersistedSchema {
            version: CURRENT_VERSION,
            schema,
        };
        let json = serde_json::to_string(&persisted)
            .map_err(|error| StorageError::Write(error.to_string()))?;

        fs::create_dir_all(&self.dir).map_err(|error| StorageError::Write(error.to_string()))?;

        let path = self.entry_path(endpoint_url);
        let tmp_path = path.with_extension("tmp");
        fs::write(&tmp_path, json).map_err(|error| StorageError::Write(error.to_string()))?;
        fs::rename(&tmp_path, &path).map_err(|error| StorageError::Write(error.to_string()))?;

        Ok(())
    }

    /// Nome de arquivo derivado de um hash da URL (não da URL em si): URLs
    /// reais carregam `:`, `/`, `?` — inválidos ou problemáticos como nome
    /// de arquivo no Windows, a plataforma primária deste projeto.
    fn entry_path(&self, endpoint_url: &str) -> PathBuf {
        let mut hasher = DefaultHasher::new();
        endpoint_url.hash(&mut hasher);
        self.dir.join(format!("{:016x}.json", hasher.finish()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("alcy-schema-store-test-{nanos}-{count}"))
    }

    #[test]
    fn get_returns_none_when_the_directory_does_not_exist() {
        let store = SchemaStore::new(temp_dir());

        assert_eq!(store.get("https://api.example.com/graphql").unwrap(), None);
    }

    #[test]
    fn save_then_get_round_trips_the_schema() {
        let dir = temp_dir();
        let store = SchemaStore::new(dir.clone());
        let schema = serde_json::json!({"queryType": "Query", "types": []});

        store
            .save("https://api.example.com/graphql", schema.clone())
            .unwrap();
        let loaded = store.get("https://api.example.com/graphql").unwrap();

        assert_eq!(loaded, Some(schema));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn keeps_entries_for_other_endpoints_when_saving_a_new_one() {
        let dir = temp_dir();
        let store = SchemaStore::new(dir.clone());

        store
            .save("https://a.example.com/graphql", serde_json::json!({"a": 1}))
            .unwrap();
        store
            .save("https://b.example.com/graphql", serde_json::json!({"b": 2}))
            .unwrap();

        assert_eq!(
            store.get("https://a.example.com/graphql").unwrap(),
            Some(serde_json::json!({"a": 1}))
        );
        assert_eq!(
            store.get("https://b.example.com/graphql").unwrap(),
            Some(serde_json::json!({"b": 2}))
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_uses_a_separate_file_per_endpoint() {
        let dir = temp_dir();
        let store = SchemaStore::new(dir.clone());

        store
            .save("https://a.example.com/graphql", serde_json::json!({"a": 1}))
            .unwrap();
        store
            .save("https://b.example.com/graphql", serde_json::json!({"b": 2}))
            .unwrap();

        let entries: Vec<_> = fs::read_dir(&dir).unwrap().collect();
        assert_eq!(entries.len(), 2);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_does_not_leave_a_temporary_file_behind() {
        let dir = temp_dir();
        let store = SchemaStore::new(dir.clone());

        store
            .save("https://api.example.com/graphql", serde_json::json!({}))
            .unwrap();

        let has_tmp_file = fs::read_dir(&dir).unwrap().any(|entry| {
            entry
                .unwrap()
                .path()
                .extension()
                .is_some_and(|e| e == "tmp")
        });
        assert!(!has_tmp_file);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_fails_with_corrupted_for_invalid_json() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        let store = SchemaStore::new(dir.clone());
        fs::write(
            store.entry_path("https://api.example.com/graphql"),
            "not json",
        )
        .unwrap();

        let error = store.get("https://api.example.com/graphql").unwrap_err();

        assert!(matches!(error, StorageError::Corrupted(_)));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_fails_with_unsupported_version_for_a_future_version() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        let store = SchemaStore::new(dir.clone());
        fs::write(
            store.entry_path("https://api.example.com/graphql"),
            r#"{"version": 99, "schema": {}}"#,
        )
        .unwrap();

        let error = store.get("https://api.example.com/graphql").unwrap_err();

        assert_eq!(
            error.to_string(),
            StorageError::UnsupportedVersion(99).to_string()
        );

        fs::remove_dir_all(&dir).ok();
    }
}
