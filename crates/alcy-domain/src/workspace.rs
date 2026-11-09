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
    #[error("invalid workspace folder name")]
    InvalidFolderName,
}

/// Longest folder name the common filesystems accept, in bytes.
const MAX_FOLDER_NAME_BYTES: usize = 255;
const FORBIDDEN_FOLDER_NAME_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
const RESERVED_FOLDER_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// The folder name to use for `raw`, without surrounding spaces. The Windows
/// rules apply on every platform because a workspace can be shared through
/// Git or a network folder.
pub fn validate_workspace_folder_name(raw: &str) -> Result<&str, WorkspaceError> {
    let name = raw.trim();
    let stem = name.split('.').next().unwrap_or(name);
    let is_valid = !name.is_empty()
        && name.len() <= MAX_FOLDER_NAME_BYTES
        // Also rules out "." and "..".
        && !name.ends_with('.')
        && !name
            .chars()
            .any(|c| c.is_control() || FORBIDDEN_FOLDER_NAME_CHARS.contains(&c))
        && !RESERVED_FOLDER_NAMES
            .iter()
            .any(|reserved| stem.eq_ignore_ascii_case(reserved));

    if is_valid {
        Ok(name)
    } else {
        Err(WorkspaceError::InvalidFolderName)
    }
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
    fn accepts_a_folder_name_without_its_surrounding_spaces() {
        assert_eq!(
            validate_workspace_folder_name("  Payments API v1.2  "),
            Ok("Payments API v1.2")
        );
    }

    #[test]
    fn rejects_folder_names_that_would_escape_or_break_a_filesystem() {
        let too_long = "a".repeat(256);
        for name in [
            "",
            "   ",
            ".",
            "..",
            "trailing.",
            "a/b",
            "a\\b",
            "a:b",
            "what?",
            "tab\tname",
            "CON",
            "nul.txt",
            "Lpt9",
            too_long.as_str(),
        ] {
            assert_eq!(
                validate_workspace_folder_name(name),
                Err(WorkspaceError::InvalidFolderName),
                "{name}"
            );
        }
    }

    #[test]
    fn accepts_folder_names_that_only_resemble_a_reserved_one() {
        for name in ["Console", "COM10", ".hidden"] {
            assert_eq!(validate_workspace_folder_name(name), Ok(name));
        }
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
