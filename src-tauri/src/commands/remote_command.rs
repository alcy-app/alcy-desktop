//! Pieces shared by the version control commands.

use std::future::Future;

use alcy_agent::AgentHttpClient;
use alcy_app::{RemoteError, VersionControlError};
use alcy_domain::GitIdentityError;
use alcy_http_proxy::{ProxyError, ProxyPlan};
use alcy_storage::StorageError;
use serde::Serialize;
use tokio::sync::oneshot;

use super::execution_registry::ExecutionRegistry;

/// Error shared by the version control commands. Never carries credentials.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RemoteCommandError {
    Invalid {
        message: String,
    },
    Storage {
        message: String,
    },
    Credentials {
        message: String,
    },
    Unauthorized,
    Network {
        message: String,
    },
    Rejected {
        message: String,
    },
    NotFound {
        message: String,
    },
    Conflict,
    TooLarge,
    Files {
        message: String,
    },
    Conflicts {
        files: Vec<String>,
    },
    NothingToCommit,
    EmptyMessage,
    IncompleteResolution {
        file: String,
    },
    NotLinked,
    Cancelled,
    /// No git author: neither set in Alcy nor in the system's git config.
    GitIdentityMissing,
    /// Files a git operation would overwrite have uncommitted changes.
    GitUncommittedChanges {
        files: Vec<String>,
    },
    /// A merge waits for its conflicts to be resolved.
    GitMergeInProgress,
    GitNoMergeInProgress,
    GitInvalidBranch {
        name: String,
    },
    /// A remote URL git would not take, or would run as a command.
    GitInvalidRemote {
        url: String,
    },
    GitNoRemote,
    /// The `git` program is needed for remotes and is not installed.
    GitNotInstalled,
    /// The remote refused the credentials, or none were available.
    GitAuthFailed {
        message: String,
    },
    /// The remote has commits this branch lacks: pull first.
    GitPushRejected,
    GitCommandFailed {
        message: String,
    },
    GitDestinationExists,
    /// The cloned repository holds no Alcy workspace.
    GitNotAWorkspace,
}

impl From<StorageError> for RemoteCommandError {
    fn from(error: StorageError) -> Self {
        Self::Storage {
            message: error.to_string(),
        }
    }
}

impl From<super::workspaces::WorkspaceCommandError> for RemoteCommandError {
    fn from(error: super::workspaces::WorkspaceCommandError) -> Self {
        use super::workspaces::WorkspaceCommandError;
        match error {
            WorkspaceCommandError::Invalid { message } => Self::Invalid { message },
            WorkspaceCommandError::NotAWorkspace { message }
            | WorkspaceCommandError::Storage { message } => Self::Storage { message },
        }
    }
}

impl From<GitIdentityError> for RemoteCommandError {
    fn from(error: GitIdentityError) -> Self {
        Self::Invalid {
            message: error.to_string(),
        }
    }
}

impl From<alcy_git::GitError> for RemoteCommandError {
    fn from(error: alcy_git::GitError) -> Self {
        use alcy_git::GitError;
        match error {
            GitError::Remote(error) => error.into(),
            GitError::Files(message) => Self::Files { message },
            GitError::IdentityMissing => Self::GitIdentityMissing,
            GitError::UncommittedChanges(files) => Self::GitUncommittedChanges { files },
            GitError::MergeInProgress => Self::GitMergeInProgress,
            GitError::NoMergeInProgress => Self::GitNoMergeInProgress,
            GitError::Conflicts(files) => Self::Conflicts { files },
            GitError::InvalidBranch(name) => Self::GitInvalidBranch { name },
            GitError::InvalidRemote(url) => Self::GitInvalidRemote { url },
            GitError::NoRemote => Self::GitNoRemote,
            GitError::GitMissing => Self::GitNotInstalled,
            GitError::Auth(message) => Self::GitAuthFailed { message },
            GitError::PushRejected => Self::GitPushRejected,
            GitError::Command(message) => Self::GitCommandFailed { message },
            GitError::DestinationExists => Self::GitDestinationExists,
            GitError::NotAWorkspace => Self::GitNotAWorkspace,
        }
    }
}

impl From<RemoteError> for RemoteCommandError {
    fn from(error: RemoteError) -> Self {
        match error {
            RemoteError::Unauthorized => Self::Unauthorized,
            RemoteError::NotFound(message) => Self::NotFound { message },
            RemoteError::Conflict => Self::Conflict,
            RemoteError::Network(message) => Self::Network { message },
            RemoteError::Rejected(message) => Self::Rejected { message },
            RemoteError::TooLarge => Self::TooLarge,
            RemoteError::Credentials(message) => Self::Credentials { message },
        }
    }
}

impl From<VersionControlError> for RemoteCommandError {
    fn from(error: VersionControlError) -> Self {
        match error {
            VersionControlError::Remote(error) => error.into(),
            VersionControlError::Files(message) => Self::Files { message },
            VersionControlError::Conflicts(files) => Self::Conflicts { files },
            VersionControlError::NothingToCommit => Self::NothingToCommit,
            VersionControlError::EmptyMessage => Self::EmptyMessage,
            VersionControlError::NotTracked(_)
            | VersionControlError::NotInConflict(_)
            | VersionControlError::ManifestRemoval
            | VersionControlError::InvalidStructuredFile(_)
            | VersionControlError::PartialResolutionUnsupported(_) => Self::Invalid {
                message: error.to_string(),
            },
            VersionControlError::StaleSelection => Self::Conflict,
            VersionControlError::IncompleteResolution(file) => Self::IncompleteResolution { file },
        }
    }
}

/// HTTP clients of the remote services (the agent), which follow the app's proxy and custom CAs like the request executors.
#[derive(Clone, Copy)]
pub struct RemoteHttpClients<'a> {
    pub agent: &'a AgentHttpClient,
}

impl RemoteHttpClients<'_> {
    pub fn reconfigure_proxy(&self, plan: &ProxyPlan) -> Result<(), ProxyError> {
        self.agent.reconfigure_proxy(plan)
    }

    pub fn set_custom_ca_certificates(&self, certificates: &[String]) -> Result<(), ProxyError> {
        self.agent.set_custom_ca_certificates(certificates)
    }
}

/// Runs `future` to completion or until `cancel_version_control_operation` is called
/// with the same `operation_id` (the operation in flight is dropped).
pub async fn cancellable<T>(
    registry: &ExecutionRegistry,
    operation_id: &str,
    future: impl Future<Output = Result<T, RemoteCommandError>>,
) -> Result<T, RemoteCommandError> {
    let (sender, receiver) = oneshot::channel::<()>();
    registry.register(operation_id.to_string(), sender);
    let result = tokio::select! {
        result = future => result,
        _ = receiver => Err(RemoteCommandError::Cancelled),
    };
    registry.remove(operation_id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_serialize_with_a_kind_and_never_leak_payloads() {
        assert_eq!(
            serde_json::to_value(RemoteCommandError::Unauthorized).unwrap(),
            serde_json::json!({"kind": "unauthorized"})
        );
        assert_eq!(
            serde_json::to_value(RemoteCommandError::Conflicts {
                files: vec!["a".into()]
            })
            .unwrap(),
            serde_json::json!({"kind": "conflicts", "files": ["a"]})
        );
        assert_eq!(
            RemoteCommandError::from(VersionControlError::Remote(RemoteError::Conflict)),
            RemoteCommandError::Conflict
        );
        assert_eq!(
            serde_json::to_value(RemoteCommandError::IncompleteResolution {
                file: "alcy-collections.json".into()
            })
            .unwrap(),
            serde_json::json!({"kind": "incompleteResolution", "file": "alcy-collections.json"})
        );
        assert_eq!(
            RemoteCommandError::from(VersionControlError::IncompleteResolution(
                "alcy-collections.json".into()
            )),
            RemoteCommandError::IncompleteResolution {
                file: "alcy-collections.json".into()
            }
        );
    }
}
