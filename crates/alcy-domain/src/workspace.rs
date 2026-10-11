use thiserror::Error;

/// Um workspace local: a pasta que o usuário escolheu para guardar os
/// dados de um projeto. Não conhece o caminho em disco — isso é
/// resolvido por quem persiste (`alcy-storage`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    pub id: String,
    name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum WorkspaceError {
    #[error("nome do workspace não pode ser vazio")]
    EmptyName,
}

impl Workspace {
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Result<Self, WorkspaceError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(WorkspaceError::EmptyName);
        }

        Ok(Self {
            id: id.into(),
            name,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// Troca o nome exibido do workspace, descartando espaços nas pontas.
    /// Não mexe na pasta em disco: a identidade do workspace continua
    /// sendo a raiz escolhida pelo usuário.
    pub fn rename(&mut self, name: &str) -> Result<(), WorkspaceError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(WorkspaceError::EmptyName);
        }

        self.name = name.to_string();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_valid_workspace() {
        let workspace = Workspace::new("workspace-1", "My API").unwrap();

        assert_eq!(workspace.id, "workspace-1");
        assert_eq!(workspace.name(), "My API");
    }

    #[test]
    fn rejects_an_empty_name() {
        assert_eq!(
            Workspace::new("workspace-1", ""),
            Err(WorkspaceError::EmptyName)
        );
        assert_eq!(
            Workspace::new("workspace-1", "   "),
            Err(WorkspaceError::EmptyName)
        );
    }

    #[test]
    fn renames_trimming_the_new_name() {
        let mut workspace = Workspace::new("workspace-1", "My API").unwrap();

        workspace.rename("  Payments API  ").unwrap();

        assert_eq!(workspace.name(), "Payments API");
        assert_eq!(workspace.id, "workspace-1");
    }

    #[test]
    fn rename_rejects_an_empty_name_and_keeps_the_previous_one() {
        let mut workspace = Workspace::new("workspace-1", "My API").unwrap();

        assert_eq!(workspace.rename("   "), Err(WorkspaceError::EmptyName));
        assert_eq!(workspace.name(), "My API");
    }
}
