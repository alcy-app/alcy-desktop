#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptDialect {
    Postman,
    Bruno,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslationWarning {
    pub line: u32,
    pub api: String,
    pub reason: &'static str,
}
pub struct Translation {
    pub source: String,
    pub warnings: Vec<TranslationWarning>,
}

/// Reescreve apenas referências no código. Strings, comentários e template
/// literals são preservados byte a byte.
pub fn translate(source: &str, dialect: ScriptDialect) -> Translation {
    let mut out = String::with_capacity(source.len());
    let mut warnings = Vec::new();
    let roots: &[&str] = match dialect {
        ScriptDialect::Postman => &["pm", "postman", "console"],
        ScriptDialect::Bruno => &["bru", "req", "res", "test", "expect", "console"],
    };
    let shadowed: Vec<&str> = roots
        .iter()
        .copied()
        .filter(|root| declares(source, root))
        .collect();
    let bytes = source.as_bytes();
    let mut i = 0;
    let mut line = 1;
    while i < bytes.len() {
        let b = bytes[i];
        if matches!(b, b'\'' | b'"' | b'`') {
            let end = quoted_end(bytes, i, b, &mut line);
            out.push_str(&source[i..end]);
            i = end;
            continue;
        }
        if b == b'/' && bytes.get(i + 1) == Some(&b'/') {
            let end = line_comment_end(bytes, i, &mut line);
            out.push_str(&source[i..end]);
            i = end;
            continue;
        }
        if b == b'/' && bytes.get(i + 1) == Some(&b'*') {
            let end = block_comment_end(bytes, i, &mut line);
            out.push_str(&source[i..end]);
            i = end;
            continue;
        }
        let mut replaced = false;
        for &(from, to) in mappings(dialect) {
            if shadowed.contains(&from.split('.').next().unwrap_or(from)) {
                continue;
            }
            if source[i..].starts_with(from) && boundary(source, i, from.len()) {
                out.push_str(to);
                i += from.len();
                replaced = true;
                break;
            }
        }
        if replaced {
            continue;
        }
        for &api in unsupported(dialect) {
            if shadowed.contains(&api.split('.').next().unwrap_or(api)) {
                continue;
            }
            if source[i..].starts_with(api) && boundary(source, i, api.len()) {
                out.push_str("al.unsupportedCommand(");
                out.push_str(&serde_json::Value::String(api.into()).to_string());
                out.push(')');
                warnings.push(TranslationWarning {
                    line,
                    api: api.into(),
                    reason: "unsupported",
                });
                i += api.len();
                replaced = true;
                break;
            }
        }
        if !replaced {
            out.push(b as char);
            if b == b'\n' {
                line += 1;
            }
            i += 1;
        }
    }
    Translation {
        source: out,
        warnings,
    }
}

pub fn isolate(source: &str) -> String {
    format!("(function () {{\n{source}\n}})();")
}

fn mappings(d: ScriptDialect) -> &'static [(&'static str, &'static str)] {
    match d {
        ScriptDialect::Postman => &[
            ("postman.setEnvironmentVariable", "al.environment.set"),
            ("postman.getEnvironmentVariable", "al.environment.get"),
            ("postman.clearEnvironmentVariable", "al.environment.unset"),
            ("pm.collectionVariables", "al.collection"),
            ("pm.iterationData", "al.iterationData"),
            ("pm.response.responseTime", "al.response.time"),
            ("pm.response.responseSize", "al.response.size"),
            ("pm.response.code", "al.response.status"),
            ("pm.response.status", "al.response.statusText"),
            ("pm.request.url.addQueryParams", "al.request.query.add"),
            (
                "pm.request.url.removeQueryParams",
                "al.request.query.remove",
            ),
            ("pm.request.body.raw", "al.request.body"),
            ("pm.info.iterationCount", "al.info.iterationCount"),
            ("pm.info.iteration", "al.info.iteration"),
            ("pm.info.eventName", "al.info.phase"),
            ("pm.environment", "al.environment"),
            ("pm.variables", "al.variables"),
            ("pm.request", "al.request"),
            ("pm.response", "al.response"),
            ("pm.test", "al.test"),
            ("pm.expect", "al.expect"),
            ("console", "al.console"),
        ],
        ScriptDialect::Bruno => &[
            ("bru.getCollectionVar", "al.collection.get"),
            ("bru.setCollectionVar", "al.collection.set"),
            ("bru.deleteCollectionVar", "al.collection.unset"),
            ("bru.getFolderVar", "al.folder.get"),
            ("bru.setFolderVar", "al.folder.set"),
            ("bru.deleteFolderVar", "al.folder.unset"),
            ("bru.getEnvVar", "al.environment.get"),
            ("bru.setEnvVar", "al.environment.set"),
            ("bru.deleteEnvVar", "al.environment.unset"),
            ("bru.getVar", "al.runtime.get"),
            ("bru.setVar", "al.runtime.set"),
            ("bru.deleteVar", "al.runtime.unset"),
            ("bru.interpolate", "al.variables.replaceIn"),
            ("req.getHeaders", "al.request.headers.toObject"),
            ("req.setHeaders", "al.request.headers.setAll"),
            ("req.getHeader", "al.request.headers.get"),
            ("req.setHeader", "al.request.headers.set"),
            ("req.deleteHeader", "al.request.headers.remove"),
            ("req.getUrl", "al.request.getUrl"),
            ("req.setUrl", "al.request.setUrl"),
            ("req.getMethod", "al.request.getMethod"),
            ("req.setMethod", "al.request.setMethod"),
            ("req.getBody", "al.request.getBody"),
            ("req.setBody", "al.request.setBody"),
            ("req.getQueryParam", "al.request.query.get"),
            ("req.setQueryParam", "al.request.query.set"),
            ("req.deleteQueryParam", "al.request.query.remove"),
            ("res.getStatusText", "al.response.getStatusText"),
            ("res.getStatus", "al.response.getStatus"),
            ("res.getHeaders", "al.response.headers.toObject"),
            ("res.getHeader", "al.response.headers.get"),
            ("res.getResponseTime", "al.response.getTime"),
            ("res.getBody", "al.response.getBody"),
            ("res.getUrl", "al.response.getUrl"),
            ("res.getSize", "al.response.getSize"),
            ("console", "al.console"),
            ("test", "al.test"),
            ("expect", "al.expect"),
        ],
    }
}
fn unsupported(d: ScriptDialect) -> &'static [&'static str] {
    match d {
        ScriptDialect::Postman => &[
            "pm.sendRequest",
            "pm.execution.runRequest",
            "pm.cookies",
            "pm.vault",
            "pm.globals",
            "pm.visualizer.set",
            "pm.request.auth",
            "pm.setNextRequest",
            "postman.setNextRequest",
            "require",
            "fetch",
            "setTimeout",
            "setInterval",
        ],
        ScriptDialect::Bruno => &[
            "bru.sendRequest",
            "bru.runRequest",
            "bru.setNextRequest",
            "bru.runner",
            "bru.getSecret",
            "bru.setSecret",
            "require",
            "fetch",
            "setTimeout",
            "setInterval",
        ],
    }
}
fn declares(source: &str, name: &str) -> bool {
    ["const ", "let ", "var ", "function ", "class "]
        .iter()
        .any(|prefix| {
            let needle = format!("{prefix}{name}");
            source
                .match_indices(&needle)
                .any(|(at, _)| boundary(source, at + prefix.len(), name.len()))
        })
}

fn boundary(s: &str, start: usize, len: usize) -> bool {
    let id = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '$';
    !s[..start].chars().next_back().is_some_and(id)
        && !s[start + len..].chars().next().is_some_and(id)
}
fn quoted_end(b: &[u8], start: usize, quote: u8, line: &mut u32) -> usize {
    let mut i = start + 1;
    while i < b.len() {
        if b[i] == b'\n' {
            *line += 1;
        }
        if b[i] == b'\\' {
            i = (i + 2).min(b.len());
            continue;
        }
        i += 1;
        if b[i - 1] == quote {
            break;
        }
    }
    i
}
fn line_comment_end(b: &[u8], start: usize, line: &mut u32) -> usize {
    let mut i = start + 2;
    while i < b.len() && b[i] != b'\n' {
        i += 1;
    }
    if i < b.len() {
        i += 1;
        *line += 1;
    }
    i
}
fn block_comment_end(b: &[u8], start: usize, line: &mut u32) -> usize {
    let mut i = start + 2;
    while i < b.len() {
        if b[i] == b'\n' {
            *line += 1;
        }
        if b[i] == b'*' && b.get(i + 1) == Some(&b'/') {
            return i + 2;
        }
        i += 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_non_code() {
        let r = translate(
            "pm.test('pm.environment'); // pm.test\n`pm.response`",
            ScriptDialect::Postman,
        );
        assert_eq!(
            r.source,
            "al.test('pm.environment'); // pm.test\n`pm.response`"
        );
    }
    #[test]
    fn blocks_io() {
        let r = translate("pm.sendRequest('x')", ScriptDialect::Postman);
        assert!(r.source.starts_with("al.unsupportedCommand"));
        assert_eq!(r.warnings.len(), 1);
    }
    #[test]
    fn respects_shadowed_globals() {
        let source = "const pm = local; pm.test('x', fn)";
        assert_eq!(translate(source, ScriptDialect::Postman).source, source);
    }

    #[test]
    fn translates_legacy_environment_variable_helpers() {
        let source = "postman.setEnvironmentVariable('token', 'x');\nconst token = postman.getEnvironmentVariable('token');\npostman.clearEnvironmentVariable('token');";

        assert_eq!(
            translate(source, ScriptDialect::Postman).source,
            "al.environment.set('token', 'x');\nconst token = al.environment.get('token');\nal.environment.unset('token');"
        );
    }
}
