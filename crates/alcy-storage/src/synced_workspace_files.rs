use alcy_app::WorkspaceFiles;
use alcy_domain::ENVIRONMENTS_FILE;

use crate::environment_store::{environments_from_portable, environments_to_portable};
use crate::local_secrets::LocalSecrets;

/// `WorkspaceFiles` visto pelo controle de versão: o arquivo de ambientes
/// entra e sai na visão portátil (sem valores cifrados; sensíveis vazios, a
/// menos que `include_sensitive`), e os demais arquivos passam intactos.
/// Hash, diff, merge, envio e recebimento operam sobre essa visão, então
/// segredos locais não vão ao remoto nem são apagados por ele.
pub struct SyncedWorkspaceFiles<F> {
    inner: F,
    secrets: LocalSecrets,
    include_sensitive: bool,
}

impl<F: WorkspaceFiles> SyncedWorkspaceFiles<F> {
    pub fn new(inner: F, secrets: LocalSecrets, include_sensitive: bool) -> Self {
        Self {
            inner,
            secrets,
            include_sensitive,
        }
    }
}

impl<F: WorkspaceFiles> WorkspaceFiles for SyncedWorkspaceFiles<F> {
    fn read(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        let content = self.inner.read(name)?;
        match content {
            Some(local) if name == ENVIRONMENTS_FILE => {
                environments_to_portable(&local, &self.secrets, self.include_sensitive)
                    .map(Some)
                    .map_err(|error| format!("{ENVIRONMENTS_FILE}: {error}"))
            }
            other => Ok(other),
        }
    }

    fn write(&self, name: &str, content: &[u8]) -> Result<(), String> {
        if name != ENVIRONMENTS_FILE {
            return self.inner.write(name, content);
        }
        let current = self.inner.read(name)?;
        let local = environments_from_portable(content, current.as_deref(), &self.secrets)
            .map_err(|error| format!("{ENVIRONMENTS_FILE}: {error}"))?;
        self.inner.write(name, &local)
    }

    fn delete(&self, name: &str) -> Result<(), String> {
        self.inner.delete(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_secrets::tests::test_secrets;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryFiles {
        files: RefCell<HashMap<String, Vec<u8>>>,
    }

    impl WorkspaceFiles for MemoryFiles {
        fn read(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
            Ok(self.files.borrow().get(name).cloned())
        }

        fn write(&self, name: &str, content: &[u8]) -> Result<(), String> {
            self.files
                .borrow_mut()
                .insert(name.to_string(), content.to_vec());
            Ok(())
        }

        fn delete(&self, name: &str) -> Result<(), String> {
            self.files.borrow_mut().remove(name);
            Ok(())
        }
    }

    const REMOTE: &str = r#"{
  "version": 1,
  "active_environment_id": "env-1",
  "environments": [
    {
      "id": "env-1",
      "name": "Development",
      "variables": [
        {
          "name": "token",
          "value": "",
          "sensitive": true
        }
      ]
    }
  ]
}"#;

    #[test]
    fn other_files_pass_through_untouched() {
        let files = SyncedWorkspaceFiles::new(MemoryFiles::default(), test_secrets(), false);

        files.write("alcy-collections.json", b"{ raw }").unwrap();

        assert_eq!(
            files.read("alcy-collections.json").unwrap(),
            Some(b"{ raw }".to_vec())
        );
        assert_eq!(
            files.inner.read("alcy-collections.json").unwrap(),
            Some(b"{ raw }".to_vec())
        );
    }

    #[test]
    fn environments_round_trip_through_the_portable_view() {
        let files = SyncedWorkspaceFiles::new(MemoryFiles::default(), test_secrets(), false);

        files.write(ENVIRONMENTS_FILE, REMOTE.as_bytes()).unwrap();

        assert_eq!(
            files.read(ENVIRONMENTS_FILE).unwrap(),
            Some(REMOTE.as_bytes().to_vec())
        );
        let local = files.inner.read(ENVIRONMENTS_FILE).unwrap().unwrap();
        assert!(String::from_utf8(local).unwrap().contains("\"version\": 2"));
    }

    #[test]
    fn invalid_environments_content_is_reported() {
        let files = SyncedWorkspaceFiles::new(MemoryFiles::default(), test_secrets(), false);
        files.inner.write(ENVIRONMENTS_FILE, b"not json").unwrap();

        assert!(files.read(ENVIRONMENTS_FILE).is_err());
        assert!(files.write(ENVIRONMENTS_FILE, b"not json").is_err());
    }
}
