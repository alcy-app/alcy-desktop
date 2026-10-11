use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use alcy_app::{CredentialError, CredentialStore};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use crate::secret_cipher::{SecretCipher, SecretError};
use crate::storage_error::StorageError;

/// Nome da entrada no chaveiro do sistema que guarda a chave local.
const KEYRING_KEY: &str = "local-secrets:encryption-key";

/// Chaves conhecidas nesta máquina: cifra com a principal e decifra tentando
/// todas. Há no máximo duas — a do chaveiro e a do arquivo reserva — e as
/// duas só coexistem se o chaveiro esteve indisponível em algum momento;
/// tentar ambas evita perder valores cifrados com qualquer uma delas.
pub struct SecretKeys {
    primary: SecretCipher,
    others: Vec<SecretCipher>,
}

impl SecretKeys {
    pub fn encrypt(&self, plaintext: &str) -> Result<String, SecretError> {
        self.primary.encrypt(plaintext)
    }

    pub fn decrypt(&self, sealed: &str) -> Result<String, SecretError> {
        let first = self.primary.decrypt(sealed);
        if first.is_ok() {
            return first;
        }
        self.others
            .iter()
            .find_map(|cipher| cipher.decrypt(sealed).ok())
            .ok_or_else(|| first.err().unwrap_or(SecretError::Undecryptable))
    }
}

struct Inner {
    credentials: Box<dyn CredentialStore>,
    fallback_path: PathBuf,
    keys: Mutex<Option<Arc<SecretKeys>>>,
}

/// Chave local usada para cifrar valores sensíveis em disco (ex.: variáveis
/// de ambiente marcadas como sensíveis). Fica no chaveiro do sistema e, só
/// quando ele não existe (ex.: Linux sem Secret Service), num arquivo
/// reserva em `app_data_dir` — nunca dentro da pasta do workspace.
///
/// A chave é carregada sob demanda, no máximo uma vez por sessão (acessar o
/// chaveiro pode levar dezenas de milissegundos); quem não tem nada sensível
/// para cifrar ou decifrar nunca chega a tocá-la. Um handle barato de
/// clonar, para poder entrar em `spawn_blocking`.
#[derive(Clone)]
pub struct LocalSecrets {
    inner: Arc<Inner>,
}

impl LocalSecrets {
    pub fn new(credentials: Box<dyn CredentialStore>, fallback_path: PathBuf) -> Self {
        Self {
            inner: Arc::new(Inner {
                credentials,
                fallback_path,
                keys: Mutex::new(None),
            }),
        }
    }

    /// Chaves desta máquina; gera e guarda uma nova na primeira vez. Uma
    /// falha não fica em cache — a próxima chamada tenta de novo.
    pub fn keys(&self) -> Result<Arc<SecretKeys>, StorageError> {
        let mut cached = self
            .inner
            .keys
            .lock()
            .map_err(|_| StorageError::Secrets("estado da chave local inconsistente".into()))?;
        if let Some(keys) = cached.as_ref() {
            return Ok(Arc::clone(keys));
        }
        let keys = Arc::new(self.load_keys()?);
        *cached = Some(Arc::clone(&keys));
        Ok(keys)
    }

    fn load_keys(&self) -> Result<SecretKeys, StorageError> {
        let from_file = read_key_file(&self.inner.fallback_path)?;
        let from_keyring = match self.inner.credentials.load(KEYRING_KEY) {
            Ok(Some(encoded)) => Some(cipher_from_encoded(&encoded)?),
            Ok(None) | Err(CredentialError::Unavailable(_)) => None,
            // Erro inesperado do chaveiro: sem o arquivo reserva, gerar uma
            // chave nova tornaria ilegível o que já foi cifrado com a antiga.
            Err(error @ CredentialError::Failed(_)) => {
                if from_file.is_none() {
                    return Err(StorageError::Secrets(error.to_string()));
                }
                None
            }
        };

        match (from_keyring, from_file) {
            (Some(primary), file) => Ok(SecretKeys {
                primary,
                others: file.into_iter().collect(),
            }),
            (None, Some(primary)) => Ok(SecretKeys {
                primary,
                others: Vec::new(),
            }),
            (None, None) => self.create_key(),
        }
    }

    fn create_key(&self) -> Result<SecretKeys, StorageError> {
        let key = SecretCipher::generate_key().map_err(secret_error)?;
        let encoded = STANDARD.encode(key);
        if self.inner.credentials.save(KEYRING_KEY, &encoded).is_err() {
            write_key_file(&self.inner.fallback_path, &encoded)?;
        }
        Ok(SecretKeys {
            primary: SecretCipher::from_key(&key).map_err(secret_error)?,
            others: Vec::new(),
        })
    }
}

fn secret_error(error: SecretError) -> StorageError {
    StorageError::Secrets(error.to_string())
}

fn cipher_from_encoded(encoded: &str) -> Result<SecretCipher, StorageError> {
    let bytes = STANDARD
        .decode(encoded.trim())
        .map_err(|_| secret_error(SecretError::InvalidKey))?;
    SecretCipher::from_key(&bytes).map_err(secret_error)
}

fn read_key_file(path: &Path) -> Result<Option<SecretCipher>, StorageError> {
    match fs::read_to_string(path) {
        Ok(encoded) => cipher_from_encoded(&encoded).map(Some),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(StorageError::Read(error.to_string())),
    }
}

/// Grava a chave com permissão só para o dono (Unix) e escrita atômica.
fn write_key_file(path: &Path, encoded: &str) -> Result<(), StorageError> {
    let write_error = |error: std::io::Error| StorageError::Write(error.to_string());
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(write_error)?;
    }
    let tmp_path = path.with_extension("tmp");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp_path).map_err(write_error)?;
    file.write_all(encoded.as_bytes()).map_err(write_error)?;
    file.sync_all().map_err(write_error)?;
    drop(file);
    fs::rename(&tmp_path, path).map_err(write_error)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Chaveiro em memória; `unavailable` simula um sistema sem chaveiro.
    #[derive(Default)]
    pub(crate) struct FakeKeyring {
        pub(crate) entries: Mutex<HashMap<String, String>>,
        pub(crate) unavailable: bool,
        pub(crate) failing: bool,
        pub(crate) loads: Arc<AtomicUsize>,
    }

    impl CredentialStore for FakeKeyring {
        fn load(&self, key: &str) -> Result<Option<String>, CredentialError> {
            self.loads.fetch_add(1, Ordering::SeqCst);
            if self.unavailable {
                return Err(CredentialError::Unavailable("sem chaveiro".into()));
            }
            if self.failing {
                return Err(CredentialError::Failed("erro".into()));
            }
            Ok(self.entries.lock().unwrap().get(key).cloned())
        }

        fn save(&self, key: &str, secret: &str) -> Result<(), CredentialError> {
            if self.unavailable {
                return Err(CredentialError::Unavailable("sem chaveiro".into()));
            }
            self.entries
                .lock()
                .unwrap()
                .insert(key.to_string(), secret.to_string());
            Ok(())
        }

        fn delete(&self, key: &str) -> Result<(), CredentialError> {
            self.entries.lock().unwrap().remove(key);
            Ok(())
        }
    }

    pub(crate) fn temp_key_path() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir()
            .join(format!("alcy-local-secrets-test-{nanos}-{count}"))
            .join("local-secret.key")
    }

    /// Segredos locais prontos para testes de outros módulos do crate.
    pub(crate) fn test_secrets() -> LocalSecrets {
        LocalSecrets::new(Box::new(FakeKeyring::default()), temp_key_path())
    }

    #[test]
    fn generates_a_key_in_the_keyring_and_caches_it() {
        let loads = Arc::new(AtomicUsize::new(0));
        let path = temp_key_path();
        let secrets = LocalSecrets::new(
            Box::new(FakeKeyring {
                loads: Arc::clone(&loads),
                ..FakeKeyring::default()
            }),
            path.clone(),
        );

        let sealed = secrets.keys().unwrap().encrypt("token").unwrap();

        assert_eq!(secrets.keys().unwrap().decrypt(&sealed).unwrap(), "token");
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        assert!(!path.exists());
    }

    #[test]
    fn reuses_the_key_already_in_the_keyring() {
        let keyring = FakeKeyring::default();
        let key = STANDARD.encode(SecretCipher::generate_key().unwrap());
        keyring.save(KEYRING_KEY, &key).unwrap();
        let sealed = cipher_from_encoded(&key).unwrap().encrypt("token").unwrap();
        let secrets = LocalSecrets::new(Box::new(keyring), temp_key_path());

        assert_eq!(secrets.keys().unwrap().decrypt(&sealed).unwrap(), "token");
    }

    #[test]
    fn falls_back_to_a_key_file_without_a_keyring() {
        let path = temp_key_path();
        let unavailable = || FakeKeyring {
            unavailable: true,
            ..FakeKeyring::default()
        };

        let sealed = LocalSecrets::new(Box::new(unavailable()), path.clone())
            .keys()
            .unwrap()
            .encrypt("token")
            .unwrap();
        let reopened = LocalSecrets::new(Box::new(unavailable()), path.clone());

        assert!(path.exists());
        assert_eq!(reopened.keys().unwrap().decrypt(&sealed).unwrap(), "token");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn still_decrypts_file_key_values_once_the_keyring_appears() {
        let path = temp_key_path();
        let sealed = LocalSecrets::new(
            Box::new(FakeKeyring {
                unavailable: true,
                ..FakeKeyring::default()
            }),
            path.clone(),
        )
        .keys()
        .unwrap()
        .encrypt("token")
        .unwrap();
        let keyring = FakeKeyring::default();
        keyring
            .save(
                KEYRING_KEY,
                &STANDARD.encode(SecretCipher::generate_key().unwrap()),
            )
            .unwrap();

        let secrets = LocalSecrets::new(Box::new(keyring), path.clone());

        assert_eq!(secrets.keys().unwrap().decrypt(&sealed).unwrap(), "token");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn does_not_generate_a_key_when_the_keyring_fails_unexpectedly() {
        let secrets = LocalSecrets::new(
            Box::new(FakeKeyring {
                failing: true,
                ..FakeKeyring::default()
            }),
            temp_key_path(),
        );

        assert!(matches!(secrets.keys(), Err(StorageError::Secrets(_))));
    }
}
