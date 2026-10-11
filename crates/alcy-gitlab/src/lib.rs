//! Cliente do GitLab (ADR 0020): OAuth 2 com PKCE e API v4.
//!
//! Compartilha proxy e certificados com o resto do app por meio de
//! `SharedHttpClient` e implementa a porta `RemoteRepository` de `alcy-app`.

mod client;
mod oauth;
mod releases;
mod repository;

pub use client::{
    GitlabBranch, GitlabClient, GitlabProject, GitlabSession, GitlabUser, Page, account_id,
    credential_key, save_tokens,
};
pub use oauth::{OAuthError, PkceChallenge, TokenSet, authorization_url, generate_state};
pub use releases::{
    GitlabProjectInfo, GitlabRelease, GitlabReleaseLink, UPDATE_MANIFEST_ASSET, is_instance_url,
};
pub use repository::GitlabRepository;
