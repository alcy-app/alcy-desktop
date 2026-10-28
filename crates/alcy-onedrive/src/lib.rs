//! OneDrive and SharePoint client (ADR 0063): Microsoft identity platform
//! OAuth with PKCE and Microsoft Graph.
//!
//! Shares proxy and certificates with the rest of the app through
//! `SharedHttpClient` and implements the `RemoteRepository` port from
//! `alcy-app`.

mod client;
mod oauth;
mod repository;
mod teams;

pub use client::{
    DriveFolder, FolderPage, OnedriveClient, OnedriveSession, OnedriveUser, account_id,
    credential_key,
};
pub use oauth::{LoginTokens, OAuthError, PkceChallenge, authorization_url, generate_state};
pub use repository::OnedriveRepository;
pub use teams::{CATALOG_FOLDER, FolderNameError, Team, TeamCatalog, validate_folder_name};
