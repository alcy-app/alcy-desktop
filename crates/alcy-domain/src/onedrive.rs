use thiserror::Error;

/// Tenant used when the build does not set one: work, school and personal
/// Microsoft accounts.
pub const DEFAULT_ONEDRIVE_TENANT: &str = "common";

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum OnedriveAccountError {
    #[error("o client_id não pode ser vazio")]
    EmptyClientId,
    #[error("o tenant da Microsoft é inválido")]
    InvalidTenant,
}

/// Normalizes a Microsoft Entra tenant: `common`, `organizations`,
/// `consumers`, a tenant GUID or a domain. Empty falls back to `common`.
pub fn normalize_tenant(input: &str) -> Result<String, OnedriveAccountError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Ok(DEFAULT_ONEDRIVE_TENANT.to_string());
    }
    let valid = trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
        && !trimmed.starts_with('.')
        && !trimmed.contains("..");
    if !valid {
        return Err(OnedriveAccountError::InvalidTenant);
    }
    Ok(trimmed.to_ascii_lowercase())
}

/// Connected Microsoft account. Never carries tokens: they live in the
/// system keyring.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnedriveAccount {
    pub id: String,
    pub tenant: String,
    pub client_id: String,
    pub username: String,
    pub name: String,
}

impl OnedriveAccount {
    pub fn new(
        id: impl Into<String>,
        tenant: &str,
        client_id: &str,
        username: impl Into<String>,
        name: impl Into<String>,
    ) -> Result<Self, OnedriveAccountError> {
        let client_id = client_id.trim();
        if client_id.is_empty() {
            return Err(OnedriveAccountError::EmptyClientId);
        }
        Ok(Self {
            id: id.into(),
            tenant: normalize_tenant(tenant)?,
            client_id: client_id.to_string(),
            username: username.into(),
            name: name.into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_tenants() {
        assert_eq!(normalize_tenant("  ").unwrap(), "common");
        assert_eq!(normalize_tenant("Organizations").unwrap(), "organizations");
        assert_eq!(
            normalize_tenant("contoso.onmicrosoft.com").unwrap(),
            "contoso.onmicrosoft.com"
        );
        assert_eq!(
            normalize_tenant("72f988bf-86f1-41af-91ab-2d7cd011db47").unwrap(),
            "72f988bf-86f1-41af-91ab-2d7cd011db47"
        );
        for invalid in ["a/b", "../x", "a?b", ".x", "a b"] {
            assert_eq!(
                normalize_tenant(invalid),
                Err(OnedriveAccountError::InvalidTenant),
                "{invalid}"
            );
        }
    }

    #[test]
    fn account_requires_a_client_id() {
        assert_eq!(
            OnedriveAccount::new("a", "", " ", "u", "U"),
            Err(OnedriveAccountError::EmptyClientId)
        );
        let account = OnedriveAccount::new("a", "", "cid", "u@x.com", "U").unwrap();
        assert_eq!(account.tenant, "common");
    }
}
