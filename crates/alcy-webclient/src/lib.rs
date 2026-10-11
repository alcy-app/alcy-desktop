//! Exportação de uma coleção ou pasta como webclient: um HTML autocontido
//! que executa as requisições no navegador, aberto direto ou servido pelo
//! `alcy-webclient-server` (ADR 0046, spec 0113).
//!
//! As regras de dados sensíveis ficam aqui, não no frontend: sem
//! confirmação explícita, nenhum segredo sai no arquivo.

mod redaction;
mod render;
mod resolve;
mod seal;
mod snapshot;
mod summary;

use alcy_domain::Collection;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::rand::{SecureRandom, SystemRandom};
use serde::Serialize;
use thiserror::Error;

pub use redaction::{
    AuthenticationField, Credential, CredentialTarget, TextSource, has_literal_secret,
    is_credential_header, is_suspicious_field_name,
};
pub use render::RUNTIME_TEMPLATE;
pub use seal::{MIN_PASSWORD_CHARS, PBKDF2_ITERATIONS, SealedEnvelope};
pub use snapshot::{ExportEnvironment, SNAPSHOT_VERSION, TransportMode, UnsupportedFeature};
pub use summary::{UnsupportedItem, WebclientSummary};

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum WebclientError {
    #[error("pasta '{0}' não encontrada na coleção")]
    FolderNotFound(String),
    #[error("o recorte não tem nenhuma requisição")]
    NoRequests,
    #[error("dados sensíveis só são exportados com confirmação explícita")]
    SensitiveNotConfirmed,
    #[error("a senha precisa ter pelo menos {minimum} caracteres")]
    PasswordTooShort { minimum: usize },
    #[error("falha ao cifrar o webclient")]
    Crypto,
    #[error("runtime do webclient inválido")]
    InvalidRuntime,
    #[error("falha ao serializar o webclient: {0}")]
    Serialization(String),
}

/// O que exportar: uma coleção inteira ou, com `folder_id`, uma pasta dela.
#[derive(Debug, Clone, Copy)]
pub struct ExportSelection<'a> {
    pub collection: &'a Collection,
    pub folder_id: Option<&'a str>,
    pub environment: Option<&'a ExportEnvironment>,
}

#[derive(Debug, Clone)]
pub struct ExportOptions {
    pub title: String,
    pub transport: TransportMode,
    pub include_sensitive: bool,
    /// Segunda marcação do diálogo; sem ela `include_sensitive` é recusado.
    pub sensitive_confirmed: bool,
    pub password: Option<String>,
}

/// Prévia do export com `include_sensitive`, sem gerar o arquivo.
pub fn summarize(
    selection: ExportSelection<'_>,
    include_sensitive: bool,
) -> Result<WebclientSummary, WebclientError> {
    let root = snapshot_root(&selection)?;
    let original_environment = selection.environment.map(plain_environment);
    let mut redacted_root = root.clone();
    let redacted = redaction::redact(&mut redacted_root, selection.environment, include_sensitive);
    Ok(summary::summarize(
        &root,
        original_environment.as_ref(),
        redacted.credentials,
    ))
}

/// Gera o HTML do webclient.
pub fn build_webclient(
    selection: ExportSelection<'_>,
    options: &ExportOptions,
) -> Result<String, WebclientError> {
    build_with_template(selection, options, RUNTIME_TEMPLATE, seal::seal)
}

fn build_with_template(
    selection: ExportSelection<'_>,
    options: &ExportOptions,
    template: &str,
    seal: impl Fn(&[u8], &str) -> Result<SealedEnvelope, WebclientError>,
) -> Result<String, WebclientError> {
    if options.include_sensitive && !options.sensitive_confirmed {
        return Err(WebclientError::SensitiveNotConfirmed);
    }
    let password = options
        .password
        .as_deref()
        .filter(|password| !password.is_empty());
    if let Some(password) = password {
        seal::validate_password(password)?;
    }

    let mut root = snapshot_root(&selection)?;
    let redacted = redaction::redact(&mut root, selection.environment, options.include_sensitive);
    let title = options.title.trim();
    let snapshot = snapshot::WebclientSnapshot {
        version: SNAPSHOT_VERSION,
        export_id: random_id()?,
        title: if title.is_empty() {
            root.name.clone()
        } else {
            title.to_string()
        },
        transport: options.transport,
        environment: redacted.environment,
        credentials: redacted.credentials,
        root,
    };
    let snapshot_json = to_json(&snapshot)?;

    let payload = match password {
        None => Payload::Plain {
            snapshot: &snapshot,
        },
        Some(password) => Payload::Sealed {
            envelope: seal(snapshot_json.as_bytes(), password)?,
        },
    };
    render::render(template, &to_json(&payload)?)
}

/// O que o runtime lê de `#alcy-webclient-data`.
#[derive(Serialize)]
#[serde(tag = "format", rename_all = "camelCase")]
enum Payload<'a> {
    Plain {
        snapshot: &'a snapshot::WebclientSnapshot,
    },
    Sealed {
        envelope: SealedEnvelope,
    },
}

fn snapshot_root(
    selection: &ExportSelection<'_>,
) -> Result<snapshot::SnapshotFolder, WebclientError> {
    let mut root = snapshot::build_root(selection.collection, selection.folder_id)?;
    let mut has_requests = false;
    snapshot::for_each_request(&root, &mut |_, _| has_requests = true);
    if !has_requests {
        return Err(WebclientError::NoRequests);
    }
    snapshot::mark_unsupported_authentication(&mut root);
    resolve::resolve_non_sensitive(&mut root, selection.environment);
    Ok(root)
}

fn plain_environment(environment: &ExportEnvironment) -> snapshot::SnapshotEnvironment {
    snapshot::SnapshotEnvironment {
        name: environment.name.clone(),
        variables: environment
            .variables
            .iter()
            .map(snapshot::to_variable)
            .collect(),
    }
}

fn to_json(value: &impl Serialize) -> Result<String, WebclientError> {
    serde_json::to_string(value).map_err(|error| WebclientError::Serialization(error.to_string()))
}

fn random_id() -> Result<String, WebclientError> {
    let mut bytes = [0u8; 12];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| WebclientError::Crypto)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{
        Authentication, Endpoint, EnvironmentVariable, Folder, HeaderEntry, ProtocolId, Request,
        RequestDocument, SavedRequest,
    };

    const TEMPLATE: &str = "<script type=\"application/json\" id=\"alcy-webclient-data\">__ALCY_WEBCLIENT_DATA__</script>";

    fn collection() -> Collection {
        let request = Request::new(
            Endpoint::new("{{baseUrl}}/graphql").unwrap(),
            RequestDocument::new(ProtocolId::GraphQl, "query { me { id } }"),
            "{}",
            vec![HeaderEntry::new("X-Api-Key", "literal-api-key", true).unwrap()],
            Authentication::Inherit,
        );
        let saved = SavedRequest::new("r1", "Me", request).unwrap();
        let folder = Folder::new("f1", "Users", vec![], vec![saved]).unwrap();
        let empty = Folder::new("f2", "Empty", vec![], vec![]).unwrap();
        Collection::new("c1", "API", vec![folder, empty], vec![])
            .unwrap()
            .with_authentication(Authentication::Bearer {
                token: "collection-literal-token".into(),
            })
    }

    fn environment() -> ExportEnvironment {
        ExportEnvironment {
            name: "Prod".into(),
            variables: vec![
                EnvironmentVariable::new("baseUrl", "https://api.example.com", false).unwrap(),
                EnvironmentVariable::new("token", "environment-secret", true).unwrap(),
            ],
        }
    }

    fn options() -> ExportOptions {
        ExportOptions {
            title: "  ".into(),
            transport: TransportMode::Auto,
            include_sensitive: false,
            sensitive_confirmed: false,
            password: None,
        }
    }

    fn fake_seal(plaintext: &[u8], password: &str) -> Result<SealedEnvelope, WebclientError> {
        seal::seal_with_iterations(plaintext, password, 1_000)
    }

    fn export(folder_id: Option<&str>, options: &ExportOptions) -> Result<String, WebclientError> {
        let collection = collection();
        let environment = environment();
        build_with_template(
            ExportSelection {
                collection: &collection,
                folder_id,
                environment: Some(&environment),
            },
            options,
            TEMPLATE,
            fake_seal,
        )
    }

    #[test]
    fn a_folder_export_has_no_secret_and_inherits_the_collection_auth_slot() {
        let html = export(Some("f1"), &options()).unwrap();

        for secret in [
            "literal-api-key",
            "collection-literal-token",
            "environment-secret",
        ] {
            assert!(!html.contains(secret), "vazou {secret}");
        }
        assert!(html.contains("\"title\":\"Users\""));
        assert!(html.contains("\"format\":\"plain\""));
        assert!(html.contains("https://api.example.com"));
        assert!(html.contains("\"id\":\"authentication:f1:Token\""));
    }

    #[test]
    fn exports_requests_with_non_sensitive_variables_resolved() {
        let html = export(Some("f1"), &options()).unwrap();

        assert!(html.contains("\"url\":\"https://api.example.com/graphql\""));
        assert!(!html.contains("{{baseUrl}}/graphql"));
    }

    #[test]
    fn a_secret_brought_by_an_unflagged_variable_is_still_redacted() {
        let request = Request::new(
            Endpoint::new("https://api.example.com/me").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![HeaderEntry::new("Authorization", "Bearer {{plainToken}}", true).unwrap()],
            Authentication::None,
        );
        let collection = Collection::new(
            "c1",
            "API",
            vec![],
            vec![SavedRequest::new("r1", "Me", request).unwrap()],
        )
        .unwrap();
        let environment = ExportEnvironment {
            name: "Prod".into(),
            variables: vec![
                EnvironmentVariable::new("plainToken", "unflagged-token-value", false).unwrap(),
            ],
        };

        let html = build_with_template(
            ExportSelection {
                collection: &collection,
                folder_id: None,
                environment: Some(&environment),
            },
            &options(),
            TEMPLATE,
            fake_seal,
        )
        .unwrap();

        let request_json = &html[html.find("\"requests\"").unwrap()..];
        assert!(!request_json.contains("unflagged-token-value"));
        assert!(html.contains("\"id\":\"header:r1:authorization\""));
    }

    #[test]
    fn sensitive_data_requires_confirmation() {
        let options = ExportOptions {
            include_sensitive: true,
            ..options()
        };

        assert_eq!(
            export(None, &options),
            Err(WebclientError::SensitiveNotConfirmed)
        );
    }

    #[test]
    fn confirmed_sensitive_data_is_exported() {
        let options = ExportOptions {
            include_sensitive: true,
            sensitive_confirmed: true,
            ..options()
        };

        let html = export(None, &options).unwrap();

        assert!(html.contains("environment-secret"));
        assert!(html.contains("collection-literal-token"));
    }

    #[test]
    fn a_password_seals_the_whole_snapshot() {
        let options = ExportOptions {
            include_sensitive: true,
            sensitive_confirmed: true,
            password: Some("correct horse".into()),
            ..options()
        };

        let html = export(None, &options).unwrap();

        assert!(html.contains("\"format\":\"sealed\""));
        for visible in [
            "environment-secret",
            "api.example.com",
            "query { me",
            "Users",
        ] {
            assert!(!html.contains(visible), "em claro: {visible}");
        }
    }

    #[test]
    fn short_passwords_are_rejected_before_any_work() {
        let options = ExportOptions {
            password: Some("short".into()),
            ..options()
        };

        assert_eq!(
            export(None, &options),
            Err(WebclientError::PasswordTooShort { minimum: 8 })
        );
    }

    #[test]
    fn an_empty_selection_is_rejected() {
        assert_eq!(
            export(Some("f2"), &options()),
            Err(WebclientError::NoRequests)
        );
    }

    #[test]
    fn summary_lists_hosts_credentials_and_counts() {
        let collection = collection();
        let environment = environment();
        let summary = summarize(
            ExportSelection {
                collection: &collection,
                folder_id: None,
                environment: Some(&environment),
            },
            false,
        )
        .unwrap();

        assert_eq!(summary.request_count, 1);
        assert_eq!(summary.folder_count, 2);
        assert_eq!(summary.hosts, vec!["api.example.com".to_string()]);
        assert!(!summary.has_unresolved_hosts);
        let ids: Vec<&str> = summary
            .credentials
            .iter()
            .map(|credential| credential.id.as_str())
            .collect();
        assert_eq!(
            ids,
            vec![
                "variable:token",
                "authentication:c1:Token",
                "header:r1:x-api-key"
            ]
        );
    }

    #[test]
    fn the_bundled_runtime_produces_a_webclient() {
        let collection = collection();
        let html = build_webclient(
            ExportSelection {
                collection: &collection,
                folder_id: None,
                environment: None,
            },
            &options(),
        )
        .unwrap();

        assert!(html.contains("\"exportId\":"));
        assert!(!html.contains(render::DATA_MARKER));
    }
}
