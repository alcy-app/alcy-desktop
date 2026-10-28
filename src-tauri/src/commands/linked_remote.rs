//! The remote behind a workspace link, whatever its provider (ADR 0063).

use alcy_app::{CommitAction, CredentialStore, RemoteError, RemoteFileMeta, RemoteRepository};
use alcy_domain::{GitlabAccount, OnedriveAccount, RemoteLocation, WorkspaceLink};
use alcy_gitlab::{GitlabClient, GitlabRepository};
use alcy_onedrive::{OnedriveClient, OnedriveRepository};
use alcy_storage::{GitlabAccountsStore, OnedriveAccountsStore};

use super::gitlab::find_account;
use super::onedrive::find_onedrive_account;
use super::remote_command::RemoteCommandError;

/// Account that owns a link, loaded from its provider's store.
pub enum LinkedAccount {
    Gitlab(GitlabAccount),
    Onedrive(OnedriveAccount),
}

impl LinkedAccount {
    pub fn find(
        link: &WorkspaceLink,
        gitlab_accounts: &GitlabAccountsStore,
        onedrive_accounts: &OnedriveAccountsStore,
    ) -> Result<Self, RemoteCommandError> {
        Ok(match &link.location {
            RemoteLocation::Gitlab { account_id, .. } => {
                Self::Gitlab(find_account(gitlab_accounts, account_id)?)
            }
            RemoteLocation::Onedrive { account_id, .. } => {
                Self::Onedrive(find_onedrive_account(onedrive_accounts, account_id)?)
            }
        })
    }

    /// Repository pointed at the link's location. A link whose provider does
    /// not match the account cannot be built by `find`, so the fallback arm
    /// only guards against misuse.
    pub fn remote<'a>(
        &'a self,
        link: &WorkspaceLink,
        gitlab: &'a GitlabClient,
        onedrive: &'a OnedriveClient,
        credentials: &'a dyn CredentialStore,
    ) -> Result<AnyRemote<'a>, RemoteCommandError> {
        match (self, &link.location) {
            (
                Self::Gitlab(account),
                RemoteLocation::Gitlab {
                    project_id, branch, ..
                },
            ) => Ok(AnyRemote::Gitlab(
                gitlab
                    .session(account, credentials)
                    .repository(*project_id, branch),
            )),
            (
                Self::Onedrive(account),
                RemoteLocation::Onedrive {
                    drive_id,
                    folder_id,
                    ..
                },
            ) => Ok(AnyRemote::Onedrive(
                onedrive
                    .session(account, credentials)
                    .repository(drive_id, folder_id),
            )),
            _ => Err(RemoteCommandError::AccountMissing),
        }
    }
}

/// `RemoteRepository` uses `impl Future`, so it is not object-safe; the
/// providers are dispatched through this enum instead.
pub enum AnyRemote<'a> {
    Gitlab(GitlabRepository<'a>),
    Onedrive(OnedriveRepository<'a>),
}

impl RemoteRepository for AnyRemote<'_> {
    async fn file_meta(&self, path: &str) -> Result<RemoteFileMeta, RemoteError> {
        match self {
            Self::Gitlab(remote) => remote.file_meta(path).await,
            Self::Onedrive(remote) => remote.file_meta(path).await,
        }
    }

    async fn read_file(&self, path: &str) -> Result<Option<Vec<u8>>, RemoteError> {
        match self {
            Self::Gitlab(remote) => remote.read_file(path).await,
            Self::Onedrive(remote) => remote.read_file(path).await,
        }
    }

    async fn commit(&self, message: &str, actions: &[CommitAction]) -> Result<String, RemoteError> {
        match self {
            Self::Gitlab(remote) => remote.commit(message, actions).await,
            Self::Onedrive(remote) => remote.commit(message, actions).await,
        }
    }
}
