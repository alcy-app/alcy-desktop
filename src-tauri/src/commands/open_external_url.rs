use serde::{Deserialize, Serialize};
use tauri_plugin_opener::OpenerExt;
use url::Url;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenExternalUrlInput {
    pub url: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpenExternalUrlError {
    Invalid { message: String },
    Failed { message: String },
}

/// Abre um link no navegador padrão do sistema. Só aceita http(s): outros
/// esquemas (`file:`, `javascript:`…) poderiam disparar programas locais.
#[tauri::command]
pub async fn open_external_url(
    input: OpenExternalUrlInput,
    app: tauri::AppHandle,
) -> Result<(), OpenExternalUrlError> {
    let url = validate_external_url(&input.url)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| OpenExternalUrlError::Failed {
            message: error.to_string(),
        })
}

fn validate_external_url(raw: &str) -> Result<Url, OpenExternalUrlError> {
    let url = Url::parse(raw.trim()).map_err(|error| OpenExternalUrlError::Invalid {
        message: error.to_string(),
    })?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        scheme => Err(OpenExternalUrlError::Invalid {
            message: format!("esquema não permitido: {scheme}"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https_urls() {
        for raw in [
            "https://alcy.dev/novidades",
            "http://localhost:3000",
            "  https://a.b  ",
        ] {
            assert!(validate_external_url(raw).is_ok(), "{raw}");
        }
    }

    #[test]
    fn rejects_other_schemes_and_malformed_urls() {
        for raw in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "mailto:a@b.c",
            "alcy.dev",
            "",
        ] {
            assert!(
                matches!(
                    validate_external_url(raw),
                    Err(OpenExternalUrlError::Invalid { .. })
                ),
                "{raw}"
            );
        }
    }

    #[test]
    fn error_serializes_with_a_kind() {
        let error = OpenExternalUrlError::Invalid {
            message: "x".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&error).ok(),
            Some(serde_json::json!({ "kind": "invalid", "message": "x" }))
        );
    }
}
