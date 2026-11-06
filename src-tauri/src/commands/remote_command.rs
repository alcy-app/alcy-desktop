//! Pieces shared by the commands of every remote provider (GitLab,
//! OneDrive, git folders) and by version control.

use std::future::Future;

use alcy_agent::AgentHttpClient;
use alcy_app::{RemoteError, VersionControlError};
use alcy_domain::{GitIdentityError, WorkspaceLinkError};
use alcy_gitlab::GitlabClient;
use alcy_http_proxy::{ProxyError, ProxyPlan};
use alcy_onedrive::OnedriveClient;
use alcy_platform::CallbackError;
use alcy_storage::StorageError;
use serde::Serialize;
use tokio::sync::oneshot;

use super::execution_registry::ExecutionRegistry;

/// Error shared by the remote provider and version control commands. Never
/// carries tokens, codes or authorization URLs.
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
    AccountMissing,
    BranchNotWritable,
    Denied {
        message: String,
    },
    Login {
        message: String,
    },
    Timeout,
    PortBusy {
        port: u16,
    },
    Browser {
        message: String,
    },
    Cancelled,
    /// No git author: neither set in Alcy nor in the system's git config.
    GitIdentityMissing,
    /// The chosen folder holds a repository with a working tree.
    GitNotBare,
    /// The chosen folder has other files and is not a git repository.
    GitNotRepository,
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
}

impl From<StorageError> for RemoteCommandError {
    fn from(error: StorageError) -> Self {
        Self::Storage {
            message: error.to_string(),
        }
    }
}

impl From<WorkspaceLinkError> for RemoteCommandError {
    fn from(error: WorkspaceLinkError) -> Self {
        Self::Invalid {
            message: error.to_string(),
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
            GitError::NotBare => Self::GitNotBare,
            GitError::NotARepository => Self::GitNotRepository,
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

impl From<CallbackError> for RemoteCommandError {
    fn from(error: CallbackError) -> Self {
        match error {
            CallbackError::PortBusy { port } => Self::PortBusy { port },
            CallbackError::Denied(message) => Self::Denied { message },
            CallbackError::Timeout => Self::Timeout,
            other => Self::Login {
                message: other.to_string(),
            },
        }
    }
}

/// HTTP clients of the remote services (providers and the agent), which
/// follow the app's proxy and custom CAs like the request executors.
#[derive(Clone, Copy)]
pub struct RemoteHttpClients<'a> {
    pub gitlab: &'a GitlabClient,
    pub onedrive: &'a OnedriveClient,
    pub agent: &'a AgentHttpClient,
}

impl RemoteHttpClients<'_> {
    pub fn reconfigure_proxy(&self, plan: &ProxyPlan) -> Result<(), ProxyError> {
        self.gitlab.reconfigure_proxy(plan)?;
        self.onedrive.reconfigure_proxy(plan)?;
        self.agent.reconfigure_proxy(plan)
    }

    pub fn set_custom_ca_certificates(&self, certificates: &[String]) -> Result<(), ProxyError> {
        self.gitlab.set_custom_ca_certificates(certificates)?;
        self.onedrive.set_custom_ca_certificates(certificates)?;
        self.agent.set_custom_ca_certificates(certificates)
    }
}

/// Runs `future` to completion or until `cancel_gitlab_operation` is called
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
            serde_json::to_value(RemoteCommandError::PortBusy { port: 53682 }).unwrap(),
            serde_json::json!({"kind": "portBusy", "port": 53682})
        );
        assert_eq!(
            serde_json::to_value(RemoteCommandError::BranchNotWritable).unwrap(),
            serde_json::json!({"kind": "branchNotWritable"})
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
