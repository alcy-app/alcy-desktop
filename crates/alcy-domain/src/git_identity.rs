//! Author of the commits written to a local git repository (ADR 0074).

use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum GitIdentityError {
    #[error("the git user name is invalid")]
    InvalidName,
    #[error("the git user e-mail is invalid")]
    InvalidEmail,
}

/// Name and e-mail recorded as author and committer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitIdentity {
    pub name: String,
    pub email: String,
}

impl GitIdentity {
    pub fn new(name: &str, email: &str) -> Result<Self, GitIdentityError> {
        Ok(Self {
            name: clean_name(name)?,
            email: clean_email(email)?,
        })
    }
}

/// Values set in Alcy that replace the system's `user.name`/`user.email`.
/// A missing field falls back to the system value; the user's git config
/// files are never changed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitIdentitySettings {
    pub name: Option<String>,
    pub email: Option<String>,
}

impl GitIdentitySettings {
    /// Validated settings: blank fields mean "use the system value".
    pub fn new(name: Option<&str>, email: Option<&str>) -> Result<Self, GitIdentityError> {
        let name = name
            .filter(|value| !value.trim().is_empty())
            .map(clean_name)
            .transpose()?;
        let email = email
            .filter(|value| !value.trim().is_empty())
            .map(clean_email)
            .transpose()?;
        Ok(Self { name, email })
    }

    /// Identity used to commit: each field from these settings, or else from
    /// the system's git config. `None` while either one stays unknown.
    pub fn resolve(
        &self,
        system_name: Option<&str>,
        system_email: Option<&str>,
    ) -> Option<GitIdentity> {
        let name = self.name.as_deref().or(system_name)?;
        let email = self.email.as_deref().or(system_email)?;
        GitIdentity::new(name, email).ok()
    }
}

/// Characters that would break the `Name <email>` signature line.
fn breaks_signature(value: &str) -> bool {
    value
        .chars()
        .any(|c| c == '<' || c == '>' || c.is_control())
}

fn clean_name(value: &str) -> Result<String, GitIdentityError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 256 || breaks_signature(value) {
        return Err(GitIdentityError::InvalidName);
    }
    Ok(value.to_string())
}

fn clean_email(value: &str) -> Result<String, GitIdentityError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 256
        || breaks_signature(value)
        || value.chars().any(char::is_whitespace)
    {
        return Err(GitIdentityError::InvalidEmail);
    }
    Ok(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_override_each_field_of_the_system_identity() {
        let none = GitIdentitySettings::default();
        assert_eq!(
            none.resolve(Some("Ana"), Some("ana@x.dev")),
            Some(GitIdentity::new("Ana", "ana@x.dev").unwrap())
        );
        assert_eq!(none.resolve(Some("Ana"), None), None);

        let email_only = GitIdentitySettings::new(Some("  "), Some(" bia@x.dev ")).unwrap();
        assert_eq!(email_only.name, None);
        assert_eq!(
            email_only.resolve(Some("Ana"), Some("ana@x.dev")),
            Some(GitIdentity::new("Ana", "bia@x.dev").unwrap())
        );

        let both = GitIdentitySettings::new(Some("Bia"), Some("bia@x.dev")).unwrap();
        assert_eq!(
            both.resolve(None, None),
            Some(GitIdentity::new("Bia", "bia@x.dev").unwrap())
        );
    }

    #[test]
    fn rejects_values_that_break_the_signature() {
        assert_eq!(
            GitIdentitySettings::new(Some("Ana <x>"), None),
            Err(GitIdentityError::InvalidName)
        );
        assert_eq!(
            GitIdentitySettings::new(None, Some("a b@x")),
            Err(GitIdentityError::InvalidEmail)
        );
        assert_eq!(
            GitIdentity::new("Ana", "ana@x\n"),
            Ok(GitIdentity::new("Ana", "ana@x").unwrap())
        );
        assert_eq!(
            GitIdentity::new("Ana\nB", "a@x"),
            Err(GitIdentityError::InvalidName)
        );
        // An invalid system value is treated as unknown.
        assert_eq!(
            GitIdentitySettings::default().resolve(Some("<bad>"), Some("a@x")),
            None
        );
    }
}
