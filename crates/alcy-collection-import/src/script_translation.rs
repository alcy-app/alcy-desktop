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

/// Rewrites references in code only. Strings, comments, template literals and
/// regular expressions are kept byte for byte.
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
    let mut i = 0;
    let mut line = 1;
    let mut code_end = 0;
    while i < source.len() {
        if let Some((end, is_code)) = literal_end(source, i, code_end, &mut line) {
            out.push_str(&source[i..end]);
            i = end;
            if is_code {
                code_end = end;
            }
            continue;
        }
        let mut replaced = false;
        for &(from, to) in mappings(dialect) {
            if shadowed.contains(&from.split('.').next().unwrap_or(from)) {
                continue;
            }
            if source[i..].starts_with(from) && is_reference(source, i, from.len()) {
                out.push_str(to);
                i += from.len();
                code_end = i;
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
            if source[i..].starts_with(api) && is_reference(source, i, api.len()) {
                out.push_str("al.unsupportedCommand(");
                out.push_str(&serde_json::Value::String(api.into()).to_string());
                out.push(')');
                warnings.push(TranslationWarning {
                    line,
                    api: api.into(),
                    reason: "unsupported",
                });
                i += api.len();
                code_end = i;
                replaced = true;
                break;
            }
        }
        if !replaced {
            let Some(ch) = source[i..].chars().next() else {
                break;
            };
            out.push(ch);
            i += ch.len_utf8();
            if ch == '\n' {
                line += 1;
            }
            if !ch.is_whitespace() {
                code_end = i;
            }
        }
    }
    Translation {
        source: out,
        warnings,
    }
}

/// Keeps the declarations of each inherited script to itself, adding no more
/// than it needs: nothing for a script running alone and a block when several
/// share a request. Only a top-level `return` needs a function around it.
pub fn scope_segment(source: &str, alone: bool) -> String {
    if has_top_level_return(source) {
        format!("(function () {{\n{source}\n}})();")
    } else if alone {
        source.to_string()
    } else {
        format!("{{\n{source}\n}}")
    }
}

/// Scans tokens rather than parsing: scripts come from imported files, and a
/// recursive parser overflows the stack on deeply nested input.
fn has_top_level_return(source: &str) -> bool {
    const CONTROL: [&str; 6] = ["if", "for", "while", "switch", "catch", "with"];
    let (mut i, mut code_end, mut line) = (0, 0, 1);
    let mut parens = Vec::new();
    let mut braces = Vec::new();
    let mut closed_paren = None;
    while i < source.len() {
        if let Some((end, is_code)) = literal_end(source, i, code_end, &mut line) {
            i = end;
            if is_code {
                code_end = end;
            }
            continue;
        }
        let Some(ch) = source[i..].chars().next() else {
            break;
        };
        match ch {
            '(' => parens.push(CONTROL.contains(&last_word(&source[..code_end]))),
            ')' => closed_paren = Some((i + 1, parens.pop().unwrap_or(false))),
            '{' => {
                let after_parameters =
                    closed_paren.is_some_and(|(end, control)| end == code_end && !control);
                braces.push(after_parameters || source[..code_end].ends_with("=>"));
            }
            '}' => {
                braces.pop();
            }
            'r' if source[i..].starts_with("return")
                && is_reference(source, i, "return".len())
                && !braces.contains(&true) =>
            {
                return true;
            }
            _ => {}
        }
        i += ch.len_utf8();
        if !ch.is_whitespace() {
            code_end = i;
        }
    }
    false
}

fn mappings(d: ScriptDialect) -> &'static [(&'static str, &'static str)] {
    match d {
        ScriptDialect::Postman => &[
            ("postman.setEnvironmentVariable", "al.environment.set"),
            ("postman.getEnvironmentVariable", "al.environment.get"),
            ("postman.clearEnvironmentVariable", "al.environment.unset"),
            ("pm.collectionVariables", "al.collection"),
            // `require` exists in the sandbox (spec 0128); `pm.require` is its
            // Postman alias for npm packages.
            ("pm.require", "al.require"),
            ("pm.iterationData", "al.iterationData"),
            ("pm.response.responseTime", "al.response.time"),
            ("pm.response.responseSize", "al.response.size"),
            ("pm.response.code", "al.response.status"),
            ("pm.response.status", "al.response.statusText"),
            ("pm.request.url.query.upsert", "al.request.query.set"),
            ("pm.request.url.query.add", "al.request.query.set"),
            ("pm.request.url.query.remove", "al.request.query.remove"),
            ("pm.request.url.query.get", "al.request.query.get"),
            ("pm.request.url.query.has", "al.request.query.has"),
            ("pm.request.url.query.toObject", "al.request.query.toObject"),
            ("pm.request.headers.upsert", "al.request.headers.set"),
            ("pm.request.headers.add", "al.request.headers.set"),
            ("pm.request.headers.clear", "al.request.headers.removeAll"),
            ("pm.request.upsertHeader", "al.request.headers.set"),
            ("pm.request.addHeader", "al.request.headers.set"),
            ("pm.request.removeHeader", "al.request.headers.remove"),
            ("pm.response.reason", "al.response.getStatusText"),
            ("pm.request.url.addQueryParams", "al.request.query.add"),
            (
                "pm.request.url.removeQueryParams",
                "al.request.query.remove",
            ),
            ("pm.request.body.raw", "al.request.body"),
            ("pm.info.iterationCount", "al.info.iterationCount"),
            ("pm.info.iteration", "al.info.iteration"),
            ("pm.info.eventName", "al.info.phase"),
            ("pm.info", "al.info"),
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
            "pm.execution.setNextRequest",
            "pm.execution.skipRequest",
            "pm.cookies",
            "pm.vault",
            "pm.globals",
            "pm.visualizer.set",
            "pm.request.auth",
            "pm.setNextRequest",
            "postman.setNextRequest",
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
/// A reference to the API, not a property or object key of the same name.
fn is_reference(s: &str, start: usize, len: usize) -> bool {
    let bare = !s[start..start + len].contains('.');
    boundary(s, start, len)
        && !s[..start].trim_end().ends_with('.')
        && !(bare && s[start + len..].trim_start().starts_with(':'))
}

/// The end of the string, comment or regular expression starting at `i`, and
/// whether it counts as code for what comes after it.
fn literal_end(source: &str, i: usize, code_end: usize, line: &mut u32) -> Option<(usize, bool)> {
    let bytes = source.as_bytes();
    match bytes[i] {
        quote @ (b'\'' | b'"' | b'`') => Some((quoted_end(bytes, i, quote, line), true)),
        b'/' if bytes.get(i + 1) == Some(&b'/') => Some((line_comment_end(bytes, i, line), false)),
        b'/' if bytes.get(i + 1) == Some(&b'*') => Some((block_comment_end(bytes, i, line), false)),
        b'/' if regex_allowed(&source[..code_end]) => regex_end(bytes, i).map(|end| (end, true)),
        _ => None,
    }
}

/// Whether a `/` after this code starts a regular expression, not a division.
fn regex_allowed(code: &str) -> bool {
    let Some(last) = code.chars().next_back() else {
        return true;
    };
    if last.is_alphanumeric() || matches!(last, '_' | '$') {
        return matches!(
            last_word(code),
            "return"
                | "typeof"
                | "case"
                | "in"
                | "of"
                | "void"
                | "delete"
                | "throw"
                | "new"
                | "else"
                | "do"
        );
    }
    !matches!(last, ')' | ']' | '\'' | '"' | '`' | '/')
        && !code.ends_with("++")
        && !code.ends_with("--")
}

fn last_word(code: &str) -> &str {
    code.rsplit(|c: char| !(c.is_alphanumeric() || matches!(c, '_' | '$')))
        .next()
        .unwrap_or("")
}

fn regex_end(b: &[u8], start: usize) -> Option<usize> {
    let mut i = start + 1;
    let mut in_class = false;
    while i < b.len() {
        match b[i] {
            b'\n' => return None,
            b'\\' => i += 1,
            b'[' => in_class = true,
            b']' => in_class = false,
            b'/' if !in_class => return Some(i + 1),
            _ => {}
        }
        i += 1;
    }
    None
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
    fn keeps_require_and_translates_pm_require() {
        let r = translate(
            "const _ = require('lodash');\nconst dayjs = pm.require('npm:dayjs@1.11.13');",
            ScriptDialect::Postman,
        );
        assert_eq!(
            r.source,
            "const _ = require('lodash');\nconst dayjs = al.require('npm:dayjs@1.11.13');"
        );
        assert!(r.warnings.is_empty());
        let bruno = translate("const moment = require('moment');", ScriptDialect::Bruno);
        assert_eq!(bruno.source, "const moment = require('moment');");
        assert!(bruno.warnings.is_empty());
    }
    #[test]
    fn respects_shadowed_globals() {
        let source = "const pm = local; pm.test('x', fn)";
        assert_eq!(translate(source, ScriptDialect::Postman).source, source);
    }

    #[test]
    fn translates_request_mutations_to_the_sandbox_api() {
        let source = "pm.request.headers.upsert({key:'A',value:'1'});\npm.request.addHeader({key:'B',value:'2'});\npm.request.removeHeader('C');\npm.request.url.query.upsert({key:'q',value:'1'});";
        assert_eq!(
            translate(source, ScriptDialect::Postman).source,
            "al.request.headers.set({key:'A',value:'1'});\nal.request.headers.set({key:'B',value:'2'});\nal.request.headers.remove('C');\nal.request.query.set({key:'q',value:'1'});"
        );
    }

    #[test]
    fn keeps_translating_after_a_regex_containing_a_quote() {
        let r = translate(
            "var s = v.replace(/'/g, ''); pm.environment.set('s', s);",
            ScriptDialect::Postman,
        );
        assert_eq!(
            r.source,
            "var s = v.replace(/'/g, ''); al.environment.set('s', s);"
        );
    }

    #[test]
    fn division_is_not_read_as_a_regex() {
        let r = translate(
            "var a = (b) / 2; pm.environment.set('a', a / 2);",
            ScriptDialect::Postman,
        );
        assert_eq!(r.source, "var a = (b) / 2; al.environment.set('a', a / 2);");
    }

    #[test]
    fn keeps_non_ascii_code_intact() {
        let r = translate(
            "const preço = '1'; pm.environment.set('p', preço);",
            ScriptDialect::Postman,
        );
        assert_eq!(
            r.source,
            "const preço = '1'; al.environment.set('p', preço);"
        );
    }

    #[test]
    fn leaves_properties_and_keys_named_like_the_api() {
        let source = "var o = { fetch: f }; o.fetch(); /x/.test(s);";
        let postman = translate(source, ScriptDialect::Postman);
        assert_eq!(postman.source, source);
        assert!(postman.warnings.is_empty());
        assert_eq!(translate(source, ScriptDialect::Bruno).source, source);
    }

    #[test]
    fn scopes_scripts_only_as_much_as_they_need() {
        assert_eq!(scope_segment("a();", true), "a();");
        assert_eq!(scope_segment("a();", false), "{\na();\n}");
        for source in [
            "if (x) { return; }\na();",
            "for (;;) { return; }",
            "return;",
        ] {
            assert!(
                scope_segment(source, true).starts_with("(function"),
                "{source}"
            );
        }
        for source in [
            "function f() { return 1; }",
            "const f = () => { return 1; };",
            "const o = { m() { return 1; } };",
            "// return\nconst s = 'return';",
            "x.return; y = { return: 1 };",
        ] {
            assert_eq!(scope_segment(source, true), source);
        }
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
