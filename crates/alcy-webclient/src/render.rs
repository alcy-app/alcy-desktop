//! Injeta o payload no runtime pré-compilado (`runtime/alcy-webclient.html`,
//! gerado por `pnpm --filter desktop run build:webclient`).
//!
//! O runtime já traz a própria CSP com os hashes dos blocos inline; o
//! payload vai num `<script type="application/json">`, que o navegador não
//! executa e por isso não precisa de hash.

use crate::WebclientError;

pub const RUNTIME_TEMPLATE: &str = include_str!("../runtime/alcy-webclient.html");
pub(crate) const DATA_MARKER: &str = "__ALCY_WEBCLIENT_DATA__";

/// Troca o marcador pelo JSON do payload. `<` vira `\u003c` (JSON válido)
/// para que nenhum valor feche o `<script>` que o contém.
pub fn render(template: &str, payload_json: &str) -> Result<String, WebclientError> {
    if template.matches(DATA_MARKER).count() != 1 {
        return Err(WebclientError::InvalidRuntime);
    }
    let escaped = payload_json
        .replace('<', "\\u003c")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    Ok(template.replacen(DATA_MARKER, &escaped, 1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use ring::digest::{SHA256, digest};

    #[test]
    fn escapes_markup_inside_the_payload() {
        let template = "<script type=\"application/json\">__ALCY_WEBCLIENT_DATA__</script>";

        let html = render(template, r#"{"a":"</script><b>"}"#).unwrap();

        assert_eq!(
            html,
            "<script type=\"application/json\">{\"a\":\"\\u003c/script>\\u003cb>\"}</script>"
        );
    }

    #[test]
    fn rejects_a_template_without_exactly_one_marker() {
        assert_eq!(
            render("<html></html>", "{}"),
            Err(WebclientError::InvalidRuntime)
        );
    }

    #[test]
    fn bundled_runtime_has_the_marker_and_a_strict_csp() {
        assert_eq!(RUNTIME_TEMPLATE.matches(DATA_MARKER).count(), 1);
        assert!(RUNTIME_TEMPLATE.contains("http-equiv=\"Content-Security-Policy\""));
        assert!(RUNTIME_TEMPLATE.contains("default-src 'none'"));
        assert!(!RUNTIME_TEMPLATE.contains("unsafe-inline"));
        assert!(!RUNTIME_TEMPLATE.contains("unsafe-eval"));
        assert!(!RUNTIME_TEMPLATE.contains(" src=\"http"));
    }

    /// Cada bloco inline executável do runtime tem o hash na CSP; sem isso o
    /// navegador bloquearia o próprio webclient.
    #[test]
    fn bundled_runtime_csp_hashes_match_the_inline_blocks() {
        for (open, close) in [
            ("<script type=\"module\">", "</script>"),
            ("<style>", "</style>"),
        ] {
            let start = RUNTIME_TEMPLATE.find(open).map(|index| index + open.len());
            let Some(start) = start else {
                panic!("runtime sem {open}");
            };
            let end = start + RUNTIME_TEMPLATE[start..].find(close).unwrap_or(0);
            let hash = STANDARD.encode(digest(&SHA256, &RUNTIME_TEMPLATE.as_bytes()[start..end]));
            assert!(
                RUNTIME_TEMPLATE.contains(&format!("'sha256-{hash}'")),
                "hash ausente para {open}"
            );
        }
    }
}
