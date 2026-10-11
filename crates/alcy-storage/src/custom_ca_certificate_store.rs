use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::storage_error::StorageError;

const CURRENT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomCaCertificate {
    pub id: String,
    pub name: String,
    pub pem: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedFile {
    version: u32,
    certificates: Vec<PersistedCertificate>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedCertificate {
    id: String,
    name: String,
    pem: String,
}

/// CAs privadas adicionadas somente ao repositório de confiança do Alcy.
/// O PEM é público, mas fica no diretório de dados para não depender do
/// caminho do arquivo escolhido na importação.
pub struct CustomCaCertificateStore {
    path: PathBuf,
}

impl CustomCaCertificateStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn load(&self) -> Result<Vec<CustomCaCertificate>, StorageError> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let raw = fs::read_to_string(&self.path)
            .map_err(|error| StorageError::Read(error.to_string()))?;
        let file: PersistedFile = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;
        if file.version != CURRENT_VERSION {
            return Err(StorageError::UnsupportedVersion(file.version));
        }
        if file.certificates.iter().any(|item| {
            item.id.is_empty() || item.name.trim().is_empty() || item.pem.trim().is_empty()
        }) {
            return Err(StorageError::Corrupted(
                "CA sem identificador, nome ou conteúdo".into(),
            ));
        }
        Ok(file
            .certificates
            .into_iter()
            .map(|item| CustomCaCertificate {
                id: item.id,
                name: item.name,
                pem: item.pem,
            })
            .collect())
    }

    pub fn save(&self, certificates: &[CustomCaCertificate]) -> Result<(), StorageError> {
        let file = PersistedFile {
            version: CURRENT_VERSION,
            certificates: certificates
                .iter()
                .map(|item| PersistedCertificate {
                    id: item.id.clone(),
                    name: item.name.clone(),
                    pem: item.pem.clone(),
                })
                .collect(),
        };
        let json = serde_json::to_string_pretty(&file)
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

    fn temp_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "alcy-custom-ca-test-{}.json",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    #[test]
    fn missing_file_is_an_empty_list() {
        assert_eq!(
            CustomCaCertificateStore::new(temp_path()).load().unwrap(),
            Vec::new()
        );
    }

    #[test]
    fn roundtrips_public_pem_content() {
        let path = temp_path();
        let store = CustomCaCertificateStore::new(path.clone());
        let certificates = vec![CustomCaCertificate {
            id: "ca-1".into(),
            name: "interna.pem".into(),
            pem: "conteúdo PEM de teste".into(),
        }];
        store.save(&certificates).unwrap();
        assert_eq!(store.load().unwrap(), certificates);
        let _ = fs::remove_file(path);
    }
}
