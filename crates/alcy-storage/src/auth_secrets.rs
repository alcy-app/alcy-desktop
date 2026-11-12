//! Secret fields of authentications (token, password, client secret, custom
//! header value) kept out of the versioned files (ADR 0078).
//!
//! A secret field whose value is only `{{…}}` placeholders stays in the file:
//! it references a value kept elsewhere and the team needs it. Any other value
//! is written empty and sealed with the local key in a secrets file beside
//! it, one value per person, as environments do (ADR 0076).

use std::collections::BTreeMap;
use std::path::Path;

use alcy_app::is_only_placeholders;
use serde::{Deserialize, Serialize};

use crate::environment_store::{read_optional, write_atomic};
use crate::local_secrets::{LazyKeys, LocalSecrets};
use crate::storage_error::StorageError;

const SECRETS_VERSION: u32 = 1;

/// Sealed values by owner (`request:<id>`, `flow:<id>/node:<id>`…) and field.
pub(crate) type SealedSlots = BTreeMap<(String, String), Vec<String>>;

/// One secret field of a persisted file, found by walking it.
pub(crate) struct Slot<'a> {
    pub(crate) owner: String,
    pub(crate) field: &'static str,
    pub(crate) value: &'a mut String,
}

impl Slot<'_> {
    fn key(&self) -> (String, String) {
        (self.owner.clone(), self.field.to_string())
    }

    /// A value of its own: not empty and not only references.
    fn is_literal(&self) -> bool {
        !is_only_placeholders(self.value)
    }
}

#[derive(Serialize, Deserialize)]
struct SecretsFile {
    version: u32,
    secrets: Vec<PersistedSecret>,
}

#[derive(Serialize, Deserialize)]
struct PersistedSecret {
    owner: String,
    field: String,
    /// One value per person who filled the field in, each opened only by
    /// that person's key.
    sealed: Vec<String>,
}

/// How to read, walk and write one versioned file that holds authentications.
pub(crate) struct SecretFields<T: 'static> {
    pub(crate) file_name: &'static str,
    pub(crate) secrets_file_name: &'static str,
    pub(crate) parse: fn(&[u8]) -> Result<T, StorageError>,
    pub(crate) serialize: fn(&T) -> Result<Vec<u8>, StorageError>,
    pub(crate) slots: for<'a> fn(&'a mut T) -> Vec<Slot<'a>>,
}

/// What receiving the portable view writes to the workspace folder.
#[derive(Debug)]
pub(crate) struct ReceivedFile {
    pub(crate) file: Vec<u8>,
    /// `None` when no sealed value is left.
    pub(crate) secrets: Option<Vec<u8>>,
}

impl<T> SecretFields<T> {
    /// Fills empty secret fields with this person's values. Returns whether
    /// the file still holds a literal secret and should be rewritten.
    pub(crate) fn open(
        &self,
        file: &mut T,
        secrets_path: &Path,
        secrets: &LocalSecrets,
    ) -> Result<bool, StorageError> {
        let stored = parse_secrets(read_optional(secrets_path)?.as_deref())?;
        let mut keys = LazyKeys::new(secrets);
        let mut holds_literal = false;
        for slot in (self.slots)(file) {
            if slot.value.is_empty() {
                let sealed = stored.get(&slot.key()).map_or(&[][..], Vec::as_slice);
                *slot.value = keys.open(sealed)?.unwrap_or_default();
            } else if slot.is_literal() {
                holds_literal = true;
            }
        }
        Ok(holds_literal)
    }

    /// Writes `file` with its literal secrets sealed as this person's. Values
    /// sealed by other people stay; an unreadable secrets file is an error
    /// rather than overwritten.
    pub(crate) fn save(
        &self,
        mut file: T,
        path: &Path,
        secrets_path: &Path,
        secrets: &LocalSecrets,
    ) -> Result<(), StorageError> {
        let current_secrets = read_optional(secrets_path)?;
        let stored = parse_secrets(current_secrets.as_deref())?;
        let mut keys = LazyKeys::new(secrets);
        let mut sealed = SealedSlots::new();
        for slot in (self.slots)(&mut file) {
            let key = slot.key();
            let previous = stored.get(&key).map_or(&[][..], Vec::as_slice);
            // A reference or an empty value removes this person's own.
            let own = if slot.is_literal() {
                std::mem::take(slot.value)
            } else {
                String::new()
            };
            let updated = keys.updated_sealed(&own, previous)?;
            if !updated.is_empty() {
                sealed.insert(key, updated);
            }
        }
        // Secrets first: an interruption leaves a value in both places, not lost.
        match secrets_to_json(&sealed)? {
            Some(json) if current_secrets.as_deref() != Some(json.as_slice()) => {
                write_atomic(secrets_path, &json)?;
            }
            None if current_secrets.is_some() => std::fs::remove_file(secrets_path)
                .map_err(|error| StorageError::Write(error.to_string()))?,
            _ => {}
        }
        write_atomic(path, &(self.serialize)(&file)?)
    }

    /// Portable view of the file: what version control reads, compares and
    /// sends. Literal secrets go empty, or with this person's values in plain
    /// text when `include_sensitive`. Unchanged bytes come back as they are,
    /// and so does a file that cannot be parsed.
    pub(crate) fn portable_view(
        &self,
        local: &[u8],
        current_secrets: Option<&[u8]>,
        secrets: &LocalSecrets,
        include_sensitive: bool,
    ) -> Result<Vec<u8>, StorageError> {
        let Ok(mut file) = (self.parse)(local) else {
            return Ok(local.to_vec());
        };
        let stored = if include_sensitive {
            parse_secrets(current_secrets)?
        } else {
            SealedSlots::new()
        };
        let mut keys = LazyKeys::new(secrets);
        let mut changed = false;
        for slot in (self.slots)(&mut file) {
            if !include_sensitive {
                if slot.is_literal() {
                    slot.value.clear();
                    changed = true;
                }
            } else if slot.value.is_empty() {
                let sealed = stored.get(&slot.key()).map_or(&[][..], Vec::as_slice);
                if let Some(value) = keys.open(sealed)? {
                    *slot.value = value;
                    changed = true;
                }
            }
        }
        if changed {
            (self.serialize)(&file)
        } else {
            Ok(local.to_vec())
        }
    }

    /// Turns the portable view (from the remote) into the local files. A
    /// literal that arrives becomes this person's sealed value; a field that
    /// arrives empty keeps the values already sealed for it (and a literal the
    /// local file still had), so receiving never erases a local secret. A file
    /// that cannot be parsed is written as is, secrets untouched.
    pub(crate) fn receive_portable(
        &self,
        portable: &[u8],
        current_local: Option<&[u8]>,
        current_secrets: Option<&[u8]>,
        secrets: &LocalSecrets,
    ) -> Result<ReceivedFile, StorageError> {
        let Ok(mut file) = (self.parse)(portable) else {
            return Ok(ReceivedFile {
                file: portable.to_vec(),
                secrets: current_secrets.map(<[u8]>::to_vec),
            });
        };
        let stored = parse_secrets(current_secrets)?;
        let mut local = current_local.and_then(|raw| (self.parse)(raw).ok());
        let local_literals: BTreeMap<(String, String), String> = local
            .as_mut()
            .map(|local| {
                (self.slots)(local)
                    .into_iter()
                    .filter(Slot::is_literal)
                    .map(|slot| (slot.key(), slot.value.clone()))
                    .collect()
            })
            .unwrap_or_default();

        let mut keys = LazyKeys::new(secrets);
        let mut sealed = SealedSlots::new();
        let mut changed = false;
        for slot in (self.slots)(&mut file) {
            let key = slot.key();
            let previous = stored.get(&key).map_or(&[][..], Vec::as_slice);
            let incoming = if slot.is_literal() {
                changed = true;
                Some(std::mem::take(slot.value))
            } else if slot.value.is_empty() {
                local_literals.get(&key).cloned()
            } else {
                None
            };
            let updated = match incoming {
                Some(value) => keys.updated_sealed(&value, previous)?,
                None => previous.to_vec(),
            };
            if !updated.is_empty() {
                sealed.insert(key, updated);
            }
        }
        Ok(ReceivedFile {
            file: if changed {
                (self.serialize)(&file)?
            } else {
                portable.to_vec()
            },
            secrets: secrets_to_json(&sealed)?,
        })
    }
}

fn parse_secrets(raw: Option<&[u8]>) -> Result<SealedSlots, StorageError> {
    let Some(raw) = raw else {
        return Ok(SealedSlots::new());
    };
    let file: SecretsFile =
        serde_json::from_slice(raw).map_err(|error| StorageError::Corrupted(error.to_string()))?;
    if file.version != SECRETS_VERSION {
        return Err(StorageError::UnsupportedVersion(file.version));
    }
    Ok(file
        .secrets
        .into_iter()
        .map(|secret| ((secret.owner, secret.field), secret.sealed))
        .collect())
}

/// `None` when there is nothing to keep: the file then does not exist.
fn secrets_to_json(sealed: &SealedSlots) -> Result<Option<Vec<u8>>, StorageError> {
    if sealed.is_empty() {
        return Ok(None);
    }
    let file = SecretsFile {
        version: SECRETS_VERSION,
        secrets: sealed
            .iter()
            .map(|((owner, field), sealed)| PersistedSecret {
                owner: owner.clone(),
                field: field.clone(),
                sealed: sealed.clone(),
            })
            .collect(),
    };
    serde_json::to_vec_pretty(&file)
        .map(Some)
        .map_err(|error| StorageError::Write(error.to_string()))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use alcy_domain::{
        Authentication, Collection, Endpoint, FlowNode, FlowNodeKind, FlowPosition, Folder,
        ProtocolId, Request, RequestDocument, SavedRequest,
    };

    use super::*;
    use crate::collections_store::{COLLECTIONS_SECRETS_FILE, SECRET_FIELDS};
    use crate::local_secrets::tests::{FakeKeyring, temp_key_path, test_secrets};
    use crate::{CollectionsStore, FlowStore, FlowsSnapshot};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("alcy-auth-secrets-test-{nanos}-{count}"))
    }

    /// Secrets whose keyring fails: any attempt to get the key is an error,
    /// which proves it was not requested.
    fn secrets_that_must_not_be_used() -> LocalSecrets {
        LocalSecrets::new(
            Box::new(FakeKeyring {
                failing: true,
                ..FakeKeyring::default()
            }),
            temp_key_path(),
        )
    }

    fn request(authentication: Authentication) -> Request {
        Request::new(
            Endpoint::new("https://api.example.com").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            authentication,
        )
    }

    fn bearer(token: &str) -> Authentication {
        Authentication::Bearer {
            token: token.to_string(),
        }
    }

    /// A collection with a Bearer request and a folder using Basic.
    fn collections(token: &str, password: &str) -> Vec<Collection> {
        let folder = Folder::new("folder-1", "Orders", vec![], vec![])
            .unwrap()
            .with_authentication(Authentication::Basic {
                username: "ana".to_string(),
                password: password.to_string(),
            });
        vec![
            Collection::new(
                "collection-1",
                "API",
                vec![folder],
                vec![SavedRequest::new("request-1", "Ping", request(bearer(token))).unwrap()],
            )
            .unwrap(),
        ]
    }

    fn manifest(root: &std::path::Path) -> String {
        fs::read_to_string(root.join("alcy-collections.json")).unwrap()
    }

    #[test]
    fn a_literal_secret_is_sealed_and_a_reference_stays_in_the_file() {
        let root = temp_root();
        let store = CollectionsStore::new(root.clone(), test_secrets());
        let saved = collections("live-token", "{{password}}");

        store.save(&saved).unwrap();

        let file = manifest(&root);
        assert!(!file.contains("live-token"), "{file}");
        assert!(file.contains(r#""token": """#), "{file}");
        assert!(file.contains(r#""password": "{{password}}""#), "{file}");
        assert!(file.contains(r#""username": "ana""#), "{file}");
        let sealed = fs::read_to_string(root.join(COLLECTIONS_SECRETS_FILE)).unwrap();
        assert!(
            sealed.contains(r#""owner": "request:request-1""#),
            "{sealed}"
        );
        assert!(!sealed.contains("live-token"), "{sealed}");
        assert_eq!(store.load().unwrap(), saved);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn nothing_secret_never_touches_the_keyring_nor_writes_a_secrets_file() {
        let root = temp_root();
        let store = CollectionsStore::new(root.clone(), secrets_that_must_not_be_used());
        let saved = collections("{{token}}", "");

        store.save(&saved).unwrap();

        assert_eq!(store.load().unwrap(), saved);
        assert!(!root.join(COLLECTIONS_SECRETS_FILE).exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn clearing_a_secret_removes_the_sealed_value() {
        let root = temp_root();
        let store = CollectionsStore::new(root.clone(), test_secrets());
        store.save(&collections("live-token", "")).unwrap();

        store.save(&collections("", "")).unwrap();

        assert!(!root.join(COLLECTIONS_SECRETS_FILE).exists());
        assert_eq!(store.load().unwrap(), collections("", ""));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn each_person_keeps_their_own_secret_in_a_shared_folder() {
        let root = temp_root();
        let ana = CollectionsStore::new(root.clone(), test_secrets());
        let bia = CollectionsStore::new(root.clone(), test_secrets());

        ana.save(&collections("ana-token", "")).unwrap();
        assert_eq!(bia.load().unwrap(), collections("", ""));
        bia.save(&collections("bia-token", "")).unwrap();

        assert_eq!(ana.load().unwrap(), collections("ana-token", ""));
        assert_eq!(bia.load().unwrap(), collections("bia-token", ""));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn listing_seals_a_file_that_still_holds_a_literal_secret() {
        let root = temp_root();
        let store = CollectionsStore::new(root.clone(), test_secrets());
        crate::export_collections(
            &root.join("alcy-collections.json"),
            &collections("old-token", "old-password"),
        )
        .unwrap();

        let loaded = store.load_and_seal().unwrap();

        assert_eq!(loaded, collections("old-token", "old-password"));
        let file = manifest(&root);
        assert!(!file.contains("old-token") && !file.contains("old-password"));
        assert_eq!(store.load().unwrap(), loaded);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn inline_flow_requests_keep_their_secret_out_of_the_flows_file() {
        let root = temp_root();
        let store = FlowStore::new(root.clone(), test_secrets());
        let node = FlowNode {
            id: "node-1".to_string(),
            kind: FlowNodeKind::InlineRequest {
                request: Box::new(
                    SavedRequest::new("inline-1", "Login", request(bearer("flow-token"))).unwrap(),
                ),
            },
            position: FlowPosition { x: 0.0, y: 0.0 },
        };
        let flow = alcy_domain::Flow::new(
            "flow-1",
            "Login",
            vec![node],
            vec![],
            UNIX_EPOCH,
            UNIX_EPOCH,
        )
        .unwrap();
        let snapshot = FlowsSnapshot {
            flows: vec![flow],
            folders: vec![],
        };

        store.save(&snapshot).unwrap();

        let file = fs::read_to_string(root.join("alcy-flows.json")).unwrap();
        assert!(!file.contains("flow-token"), "{file}");
        let sealed = fs::read_to_string(root.join("alcy-flows-secrets.json")).unwrap();
        assert!(sealed.contains("flow:flow-1/node:node-1"), "{sealed}");
        assert_eq!(store.load().unwrap(), snapshot);
        fs::remove_dir_all(&root).ok();
    }

    fn file_with_token(token: &str) -> Vec<u8> {
        let root = temp_root();
        crate::export_collections(&root.join("c.json"), &collections(token, "")).unwrap();
        let bytes = fs::read(root.join("c.json")).unwrap();
        fs::remove_dir_all(&root).ok();
        bytes
    }

    #[test]
    fn the_portable_view_drops_literals_and_keeps_clean_files_byte_for_byte() {
        let secrets = secrets_that_must_not_be_used();
        let clean = file_with_token("{{token}}");
        assert_eq!(
            SECRET_FIELDS
                .portable_view(&clean, None, &secrets, false)
                .unwrap(),
            clean
        );

        let portable = SECRET_FIELDS
            .portable_view(&file_with_token("leaked"), None, &secrets, false)
            .unwrap();
        assert_eq!(portable, file_with_token(""));
    }

    #[test]
    fn the_portable_view_carries_this_persons_value_when_sensitive_values_sync() {
        let root = temp_root();
        let secrets = test_secrets();
        CollectionsStore::new(root.clone(), secrets.clone())
            .save(&collections("mine", ""))
            .unwrap();
        let sealed = fs::read(root.join(COLLECTIONS_SECRETS_FILE)).unwrap();

        let portable = SECRET_FIELDS
            .portable_view(manifest(&root).as_bytes(), Some(&sealed), &secrets, true)
            .unwrap();

        assert_eq!(portable, file_with_token("mine"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn receiving_seals_an_incoming_literal_and_keeps_local_secrets_for_empty_fields() {
        let secrets = test_secrets();

        let received = SECRET_FIELDS
            .receive_portable(&file_with_token("theirs"), None, None, &secrets)
            .unwrap();
        assert_eq!(received.file, file_with_token(""));
        let sealed = received.secrets.unwrap();

        // An empty field from the remote keeps the sealed value.
        let again = SECRET_FIELDS
            .receive_portable(
                &file_with_token(""),
                Some(&received.file),
                Some(&sealed),
                &secrets,
            )
            .unwrap();
        assert_eq!(again.file, file_with_token(""));
        assert_eq!(again.secrets.as_deref(), Some(sealed.as_slice()));

        // A literal the local file still had is sealed, not lost.
        let kept = SECRET_FIELDS
            .receive_portable(
                &file_with_token(""),
                Some(&file_with_token("local")),
                None,
                &secrets,
            )
            .unwrap();
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("alcy-collections.json"), &kept.file).unwrap();
        fs::write(root.join(COLLECTIONS_SECRETS_FILE), kept.secrets.unwrap()).unwrap();
        assert_eq!(
            CollectionsStore::new(root.clone(), secrets).load().unwrap(),
            collections("local", "")
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn unparseable_files_pass_through_untouched() {
        let secrets = secrets_that_must_not_be_used();
        assert_eq!(
            SECRET_FIELDS
                .portable_view(b"not json", None, &secrets, false)
                .unwrap(),
            b"not json"
        );
        let received = SECRET_FIELDS
            .receive_portable(b"not json", None, Some(b"kept"), &secrets)
            .unwrap();
        assert_eq!(received.file, b"not json");
        assert_eq!(received.secrets.as_deref(), Some(&b"kept"[..]));
    }
}
