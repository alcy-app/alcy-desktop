//! Importação de comandos `curl` e `wget` (spec 0081) — o inverso do
//! "Compartilhar como código". Cada comando do texto vira uma requisição de
//! uma única coleção. O texto é lido com as regras de aspas do shell POSIX
//! (aspas simples, duplas, `$'…'` e continuação com `\`); comandos depois de
//! um `|` e comandos que não são `curl`/`wget` são ignorados.

use std::collections::HashSet;

use alcy_domain::{
    Authentication, BodyPayload, Collection, FormDataField, FormDataFieldValue, HeaderEntry,
    ProtocolId, RawBodyLanguage, SavedRequest, UrlEncodedField,
};
use serde_json::Value;

use super::{
    CollectionImportError, FALLBACK_COLLECTION_NAME, IdGenerator, ImportedCollectionData,
    build_request, ensure_content_type, raw_language_from_mime, unique_name,
};

/// Opções longas do curl que recebem valor — as tratadas em `apply_curl` e
/// as ignoradas, cujo valor não pode ser confundido com a URL.
const CURL_LONG_WITH_VALUE: &[&str] = &[
    "request",
    "url",
    "header",
    "data",
    "data-ascii",
    "data-binary",
    "data-raw",
    "data-urlencode",
    "json",
    "form",
    "form-string",
    "user",
    "oauth2-bearer",
    "user-agent",
    "referer",
    "cookie",
    "url-query",
    "upload-file",
    "output",
    "output-dir",
    "max-time",
    "connect-timeout",
    "proxy",
    "proxy-user",
    "proxy-header",
    "preproxy",
    "noproxy",
    "socks4",
    "socks4a",
    "socks5",
    "socks5-hostname",
    "write-out",
    "retry",
    "retry-delay",
    "retry-max-time",
    "cookie-jar",
    "cacert",
    "capath",
    "cert",
    "cert-type",
    "key",
    "key-type",
    "pass",
    "pinnedpubkey",
    "ciphers",
    "tls-max",
    "resolve",
    "connect-to",
    "interface",
    "local-port",
    "dns-servers",
    "limit-rate",
    "speed-limit",
    "speed-time",
    "max-filesize",
    "max-redirs",
    "range",
    "continue-at",
    "config",
    "netrc-file",
    "trace",
    "trace-ascii",
    "stderr",
    "dump-header",
    "time-cond",
    "proto",
    "proto-redir",
    "unix-socket",
    "abstract-unix-socket",
    "aws-sigv4",
    "request-target",
    "expect100-timeout",
    "happy-eyeballs-timeout-ms",
    "keepalive-time",
    "parallel-max",
    "create-file-mode",
    "etag-save",
    "etag-compare",
    "service-name",
    "delegation",
    "login-options",
    "mail-from",
    "mail-rcpt",
    "ftp-port",
    "quote",
    "variable",
    "hostpubmd5",
];

/// Letras de opção curta do curl que recebem valor.
const CURL_SHORT_WITH_VALUE: &str = "XHdFuAebTomxwcEKrUyYzCQtP";

const WGET_LONG_WITH_VALUE: &[&str] = &[
    "method",
    "header",
    "body-data",
    "body-file",
    "post-data",
    "post-file",
    "user",
    "password",
    "http-user",
    "http-password",
    "user-agent",
    "referer",
    "output-document",
    "output-file",
    "append-output",
    "tries",
    "timeout",
    "dns-timeout",
    "connect-timeout",
    "read-timeout",
    "wait",
    "waitretry",
    "limit-rate",
    "quota",
    "directory-prefix",
    "load-cookies",
    "save-cookies",
    "ca-certificate",
    "ca-directory",
    "certificate",
    "certificate-type",
    "private-key",
    "private-key-type",
    "secure-protocol",
    "ciphers",
    "execute",
    "input-file",
    "base",
    "config",
    "bind-address",
    "level",
    "accept",
    "reject",
    "domains",
    "exclude-domains",
    "local-encoding",
    "remote-encoding",
    "proxy-user",
    "proxy-password",
    "default-page",
    "restrict-file-names",
    "max-redirect",
];

/// Letras de opção curta do wget que recebem valor.
const WGET_SHORT_WITH_VALUE: &str = "OoaUTtweiPQlARDB";

/// `Ok` com a coleção importada quando o texto começa com um comando `curl`
/// ou `wget`; `NotRecognized` caso contrário, para os demais formatos
/// tentarem.
pub fn parse_shell_commands(raw: &str) -> Result<ImportedCollectionData, CollectionImportError> {
    if !starts_with_supported_command(raw) {
        return Err(CollectionImportError::NotRecognized);
    }

    let mut ids = IdGenerator::new();
    let mut names = HashSet::new();
    let mut requests = Vec::new();
    let mut collection_name = None;
    for command in split_commands(raw)? {
        if command.piped {
            continue;
        }
        let words = strip_prompt(&command.words);
        let Some((program, args)) = words.split_first() else {
            continue;
        };
        let call = match program_name(program) {
            Some(Program::Curl) => parse_curl(args),
            Some(Program::Wget) => parse_wget(args),
            None => continue,
        };
        let url = call.url.clone().ok_or_else(|| {
            CollectionImportError::Invalid("comando sem URL para importar".to_string())
        })?;
        collection_name.get_or_insert_with(|| host_of(&with_scheme(&url)).to_string());
        requests.push(call.into_request(&mut ids, &mut names)?);
    }

    if requests.is_empty() {
        return Err(CollectionImportError::Invalid(
            "nenhum comando curl ou wget encontrado".to_string(),
        ));
    }
    let name = collection_name
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| FALLBACK_COLLECTION_NAME.to_string());
    let collection = Collection::new(ids.next("collection"), name, Vec::new(), requests)?;
    Ok(ImportedCollectionData {
        collections: vec![collection],
        environments: Vec::new(),
        source_kind: None,
        docs: None,
        script_count: 0,
        warnings: Vec::new(),
    })
}

// ---------------------------------------------------------------------------
// Leitura do texto como shell
// ---------------------------------------------------------------------------

enum Program {
    Curl,
    Wget,
}

/// Aceita `curl`, `wget`, caminhos (`/usr/bin/curl`) e `curl.exe`.
fn program_name(word: &str) -> Option<Program> {
    let name = word.rsplit(['/', '\\']).next().unwrap_or(word);
    let name = name.to_ascii_lowercase();
    match name.strip_suffix(".exe").unwrap_or(&name) {
        "curl" => Some(Program::Curl),
        "wget" => Some(Program::Wget),
        _ => None,
    }
}

/// Um `$` sozinho no início é o prompt copiado junto do comando.
fn strip_prompt(words: &[String]) -> &[String] {
    match words.split_first() {
        Some((first, rest)) if first == "$" => rest,
        _ => words,
    }
}

/// Checagem barata antes de interpretar o texto inteiro como shell: a
/// primeira linha que não é comentário precisa começar por `curl` ou `wget`.
fn starts_with_supported_command(raw: &str) -> bool {
    let Some(line) = raw
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
    else {
        return false;
    };
    let line = line.strip_prefix("$ ").map(str::trim_start).unwrap_or(line);
    line.split_whitespace()
        .next()
        .and_then(program_name)
        .is_some()
}

struct Command {
    words: Vec<String>,
    /// Recebe a saída de outro comando (`curl … | jq`), portanto não é uma
    /// requisição a importar.
    piped: bool,
}

fn unterminated() -> CollectionImportError {
    CollectionImportError::Invalid("comando com aspas não fechadas".to_string())
}

fn split_commands(raw: &str) -> Result<Vec<Command>, CollectionImportError> {
    let mut commands = Vec::new();
    let mut words: Vec<String> = Vec::new();
    let mut word: Option<String> = None;
    let mut piped = false;
    let mut chars = raw.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            ' ' | '\t' => words.extend(word.take()),
            '\n' | '\r' | ';' | '|' | '&' => {
                let doubled = matches!(ch, '|' | '&') && chars.peek() == Some(&ch);
                // `&` sozinho no meio de uma palavra é quase sempre uma URL
                // colada sem aspas, não um comando em segundo plano.
                if ch == '&'
                    && !doubled
                    && word.is_some()
                    && chars.peek().is_some_and(|next| !next.is_whitespace())
                {
                    word.get_or_insert_with(String::new).push(ch);
                    continue;
                }
                if doubled {
                    chars.next();
                }
                words.extend(word.take());
                if !words.is_empty() {
                    commands.push(Command {
                        words: std::mem::take(&mut words),
                        piped,
                    });
                    piped = false;
                }
                if ch == '|' && !doubled {
                    piped = true;
                }
            }
            '#' if word.is_none() => while chars.next_if(|next| *next != '\n').is_some() {},
            '\\' => match chars.next() {
                Some('\n') => {}
                Some('\r') => {
                    chars.next_if_eq(&'\n');
                }
                Some(escaped) => word.get_or_insert_with(String::new).push(escaped),
                None => word.get_or_insert_with(String::new).push('\\'),
            },
            '\'' => {
                let target = word.get_or_insert_with(String::new);
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(next) => target.push(next),
                        None => return Err(unterminated()),
                    }
                }
            }
            '"' => {
                let target = word.get_or_insert_with(String::new);
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.peek() {
                            Some('"' | '\\' | '$' | '`') => target.extend(chars.next()),
                            Some('\n') => {
                                chars.next();
                            }
                            _ => target.push('\\'),
                        },
                        Some(next) => target.push(next),
                        None => return Err(unterminated()),
                    }
                }
            }
            '$' if chars.peek() == Some(&'\'') => {
                chars.next();
                read_ansi_c_quoted(&mut chars, word.get_or_insert_with(String::new))?;
            }
            other => word.get_or_insert_with(String::new).push(other),
        }
    }

    words.extend(word);
    if !words.is_empty() {
        commands.push(Command { words, piped });
    }
    Ok(commands)
}

/// Conteúdo de `$'…'` (o `$'` já foi consumido), com os escapes do bash.
fn read_ansi_c_quoted(
    chars: &mut std::iter::Peekable<std::str::Chars<'_>>,
    target: &mut String,
) -> Result<(), CollectionImportError> {
    loop {
        match chars.next().ok_or_else(unterminated)? {
            '\'' => return Ok(()),
            '\\' => {
                let escaped = chars.next().ok_or_else(unterminated)?;
                match escaped {
                    'n' => target.push('\n'),
                    't' => target.push('\t'),
                    'r' => target.push('\r'),
                    'a' => target.push('\x07'),
                    'b' => target.push('\x08'),
                    'e' | 'E' => target.push('\x1b'),
                    'f' => target.push('\x0c'),
                    'v' => target.push('\x0b'),
                    '\\' | '\'' | '"' | '?' => target.push(escaped),
                    'x' => push_code_point(chars, target, 16, 2, "\\x"),
                    'u' => push_code_point(chars, target, 16, 4, "\\u"),
                    'U' => push_code_point(chars, target, 16, 8, "\\U"),
                    '0'..='7' => {
                        let mut code = escaped.to_digit(8).unwrap_or_default();
                        for _ in 0..2 {
                            let Some(digit) = chars.peek().and_then(|next| next.to_digit(8)) else {
                                break;
                            };
                            code = code * 8 + digit;
                            chars.next();
                        }
                        target.extend(char::from_u32(code));
                    }
                    other => {
                        target.push('\\');
                        target.push(other);
                    }
                }
            }
            other => target.push(other),
        }
    }
}

fn push_code_point(
    chars: &mut std::iter::Peekable<std::str::Chars<'_>>,
    target: &mut String,
    radix: u32,
    max_digits: usize,
    prefix: &str,
) {
    let mut code = 0;
    let mut digits = 0;
    while digits < max_digits {
        let Some(digit) = chars.peek().and_then(|next| next.to_digit(radix)) else {
            break;
        };
        code = code * radix + digit;
        digits += 1;
        chars.next();
    }
    match char::from_u32(code).filter(|_| digits > 0) {
        Some(decoded) => target.push(decoded),
        None => target.push_str(prefix),
    }
}

// ---------------------------------------------------------------------------
// Opções do curl e do wget
// ---------------------------------------------------------------------------

enum DataPart {
    Text(String),
    /// Valor de `--data-urlencode`, que o curl codifica antes de enviar.
    UrlEncode(String),
    File(String),
}

#[derive(Default)]
struct ParsedCall {
    method: Option<String>,
    url: Option<String>,
    query: Vec<String>,
    headers: Vec<(String, String)>,
    data: Vec<DataPart>,
    form: Vec<FormDataField>,
    credentials: Option<(String, String)>,
    digest: bool,
    bearer: Option<String>,
    head: bool,
    get: bool,
    json: bool,
    upload: bool,
}

/// Percorre as opções no formato comum a curl e wget (`--nome valor`,
/// `--nome=valor`, `-X valor`, `-Xvalor`, `-sSL`), entregando o nome longo
/// (ou a letra) e o valor a `apply`; o primeiro argumento solto é a URL.
fn walk_options(
    args: &[String],
    long_with_value: &[&str],
    short_with_value: &str,
    call: &mut ParsedCall,
    mut apply: impl FnMut(&mut ParsedCall, &str, Option<String>),
) {
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        if arg == "--" {
            if call.url.is_none() {
                call.url = rest.next().cloned();
            }
            break;
        }
        if let Some(long) = arg.strip_prefix("--") {
            let (name, inline) = match long.split_once('=') {
                Some((name, value)) => (name, Some(value.to_string())),
                None => (long, None),
            };
            let value = match inline {
                Some(value) => Some(value),
                None if long_with_value.contains(&name) => rest.next().cloned(),
                None => None,
            };
            apply(call, name, value);
            continue;
        }
        if let Some(cluster) = arg.strip_prefix('-').filter(|cluster| !cluster.is_empty()) {
            for (index, letter) in cluster.char_indices() {
                let mut buffer = [0; 4];
                let short = letter.encode_utf8(&mut buffer);
                if short_with_value.contains(letter) {
                    let attached = &cluster[index + letter.len_utf8()..];
                    let value = if attached.is_empty() {
                        rest.next().cloned()
                    } else {
                        Some(attached.to_string())
                    };
                    apply(call, short, value);
                    break;
                }
                apply(call, short, None);
            }
            continue;
        }
        if call.url.is_none() {
            call.url = Some(arg.clone());
        }
    }
}

fn parse_curl(args: &[String]) -> ParsedCall {
    let mut call = ParsedCall::default();
    walk_options(
        args,
        CURL_LONG_WITH_VALUE,
        CURL_SHORT_WITH_VALUE,
        &mut call,
        |call, name, value| {
            let name = match name {
                "X" => "request",
                "H" => "header",
                "d" => "data",
                "F" => "form",
                "u" => "user",
                "A" => "user-agent",
                "e" => "referer",
                "b" => "cookie",
                "T" => "upload-file",
                "I" => "head",
                "G" => "get",
                other => other,
            };
            apply_curl(call, name, value);
        },
    );
    call
}

fn apply_curl(call: &mut ParsedCall, name: &str, value: Option<String>) {
    let Some(value) = value else {
        match name {
            "digest" => call.digest = true,
            "basic" => call.digest = false,
            "head" => call.head = true,
            "get" => call.get = true,
            _ => {}
        }
        return;
    };
    match name {
        "request" => call.method = Some(value),
        "url" => {
            call.url.get_or_insert(value);
        }
        "header" => call.push_header_line(&value, false),
        "data" | "data-ascii" | "data-binary" => call.data.push(data_part(value)),
        "data-raw" => call.data.push(DataPart::Text(value)),
        "data-urlencode" => call.data.push(DataPart::UrlEncode(value)),
        "json" => {
            call.json = true;
            call.data.push(data_part(value));
        }
        "form" => call.form.extend(form_field(&value, false)),
        "form-string" => call.form.extend(form_field(&value, true)),
        "user" => {
            let (username, password) = value.split_once(':').unwrap_or((&value, ""));
            call.credentials = Some((username.to_string(), password.to_string()));
        }
        "oauth2-bearer" => call.bearer = Some(value),
        "user-agent" => call.headers.push(("User-Agent".to_string(), value)),
        "referer" => {
            let referer = value.strip_suffix(";auto").unwrap_or(&value);
            if !referer.is_empty() {
                call.headers
                    .push(("Referer".to_string(), referer.to_string()));
            }
        }
        // Sem `=` o valor é um arquivo de cookies, não o conteúdo do header.
        "cookie" if value.contains('=') => call.headers.push(("Cookie".to_string(), value)),
        "url-query" => call.query.push(encode_data_urlencode(&value)),
        "upload-file" => {
            call.upload = true;
            call.data.push(DataPart::File(value));
        }
        _ => {}
    }
}

fn data_part(value: String) -> DataPart {
    match value.strip_prefix('@') {
        Some(path) if path != "-" => DataPart::File(path.to_string()),
        _ => DataPart::Text(value),
    }
}

fn parse_wget(args: &[String]) -> ParsedCall {
    let mut call = ParsedCall::default();
    let mut auth_no_challenge = false;
    walk_options(
        args,
        WGET_LONG_WITH_VALUE,
        WGET_SHORT_WITH_VALUE,
        &mut call,
        |call, name, value| {
            let Some(value) = value else {
                if name == "auth-no-challenge" {
                    auth_no_challenge = true;
                }
                return;
            };
            match name {
                "method" => call.method = Some(value),
                "header" => call.push_header_line(&value, true),
                "body-data" | "post-data" => call.data.push(DataPart::Text(value)),
                "body-file" | "post-file" => call.data.push(DataPart::File(value)),
                "user" | "http-user" => call.credentials.get_or_insert_default().0 = value,
                "password" | "http-password" => call.credentials.get_or_insert_default().1 = value,
                "user-agent" | "U" => call.headers.push(("User-Agent".to_string(), value)),
                "referer" => call.headers.push(("Referer".to_string(), value)),
                _ => {}
            }
        },
    );
    // Sem `--auth-no-challenge` o wget só manda as credenciais depois do
    // desafio do servidor — o caso de Digest, que é também como o
    // "Compartilhar como código" gera o wget com usuário e senha.
    call.digest = !auth_no_challenge;
    call
}

/// `curl -F`/`--form-string`: `nome=valor`, `nome=@arquivo` ou
/// `nome=<arquivo`, com parâmetros opcionais (`;type=…`, `;filename=…`).
fn form_field(value: &str, literal: bool) -> Option<FormDataField> {
    let (name, content) = value.split_once('=')?;
    if name.is_empty() {
        return None;
    }
    let value = if literal {
        FormDataFieldValue::Text(content.to_string())
    } else if let Some(path) = content
        .strip_prefix('@')
        .or_else(|| content.strip_prefix('<'))
    {
        FormDataFieldValue::File {
            file_path: strip_form_params(path).to_string(),
        }
    } else {
        FormDataFieldValue::Text(strip_form_params(content).to_string())
    };
    Some(FormDataField {
        name: name.to_string(),
        enabled: true,
        value,
    })
}

fn strip_form_params(value: &str) -> &str {
    [";type=", ";filename=", ";headers=", ";encoder="]
        .iter()
        .filter_map(|param| value.find(param))
        .min()
        .map_or(value, |end| &value[..end])
}

impl ParsedCall {
    /// `Nome: valor`; `Nome;` é o header vazio do curl e `Nome:` sem valor
    /// remove o header no curl (mas é um header vazio no wget).
    fn push_header_line(&mut self, line: &str, keep_empty: bool) {
        if let Some((name, value)) = line.split_once(':') {
            let value = value.trim();
            if !value.is_empty() || keep_empty {
                self.headers
                    .push((name.trim().to_string(), value.to_string()));
            }
        } else if let Some(name) = line.strip_suffix(';') {
            self.headers.push((name.trim().to_string(), String::new()));
        }
    }

    fn into_request(
        self,
        ids: &mut IdGenerator,
        names: &mut HashSet<String>,
    ) -> Result<SavedRequest, CollectionImportError> {
        let mut url = with_scheme(self.url.as_deref().unwrap_or_default());
        let mut headers = self
            .headers
            .iter()
            .filter(|(name, _)| !name.is_empty())
            .map(|(name, value)| HeaderEntry::new(name, value, true))
            .collect::<Result<Vec<_>, _>>()?;
        for query in &self.query {
            append_raw_query(&mut url, query);
        }

        let has_body = !self.form.is_empty() || (!self.data.is_empty() && !self.get);
        let method = self.method.clone().unwrap_or_else(|| {
            if self.head {
                "HEAD"
            } else if self.upload && self.form.is_empty() {
                "PUT"
            } else if has_body {
                "POST"
            } else {
                "GET"
            }
            .to_string()
        });

        let authentication = match (self.bearer, self.credentials) {
            (Some(token), _) => Authentication::Bearer { token },
            (None, Some((username, password))) if self.digest => {
                Authentication::Digest { username, password }
            }
            (None, Some((username, password))) => Authentication::Basic { username, password },
            (None, None) => Authentication::None,
        };

        let (protocol, body, variables, payload) = if !self.form.is_empty() {
            // O boundary é gerado no envio; um `multipart/form-data` fixo quebraria o corpo.
            headers.retain(|header| {
                !is_content_type(header)
                    || !header
                        .value()
                        .to_ascii_lowercase()
                        .starts_with("multipart/form-data")
            });
            (
                ProtocolId::Rest,
                String::new(),
                String::new(),
                BodyPayload::FormData(self.form),
            )
        } else if self.get {
            let query = joined_data(&self.data);
            if !query.is_empty() {
                append_raw_query(&mut url, &query);
            }
            (
                ProtocolId::Rest,
                String::new(),
                String::new(),
                BodyPayload::None,
            )
        } else {
            data_body(&self.data, self.json, &mut headers)?
        };

        let name = unique_name(&request_name(&method, &url), names);
        build_request(
            ids,
            &name,
            Some(method.as_str()),
            url,
            headers,
            authentication,
            protocol,
            body,
            variables,
            payload,
        )
    }
}

// ---------------------------------------------------------------------------
// Corpo
// ---------------------------------------------------------------------------

type MappedBody = (ProtocolId, String, String, BodyPayload);

fn data_body(
    parts: &[DataPart],
    json: bool,
    headers: &mut Vec<HeaderEntry>,
) -> Result<MappedBody, CollectionImportError> {
    if json {
        ensure_content_type(headers, "application/json")?;
        if !headers
            .iter()
            .any(|header| header.name().eq_ignore_ascii_case("accept"))
        {
            headers.push(HeaderEntry::new("Accept", "application/json", true)?);
        }
    }
    match parts {
        [] => {
            return Ok((
                ProtocolId::Rest,
                String::new(),
                String::new(),
                BodyPayload::None,
            ));
        }
        [DataPart::File(path)] => {
            return Ok((
                ProtocolId::Rest,
                String::new(),
                String::new(),
                BodyPayload::Binary {
                    file_path: path.clone(),
                },
            ));
        }
        _ => {}
    }
    if let Some(fields) = urlencoded_parts(parts) {
        ensure_content_type(headers, "application/x-www-form-urlencoded")?;
        return Ok(urlencoded_body(fields));
    }
    text_body(joined_data(parts), headers)
}

/// Todas as partes são `--data-urlencode nome=valor`: cada uma vira um
/// campo editável. O nome já vem codificado; o valor, não.
fn urlencoded_parts(parts: &[DataPart]) -> Option<Vec<UrlEncodedField>> {
    parts
        .iter()
        .map(|part| {
            let DataPart::UrlEncode(value) = part else {
                return None;
            };
            let (name, value) = value.split_once('=')?;
            let name = percent_decode(name, false)?;
            (!name.is_empty()).then(|| UrlEncodedField {
                name,
                value: value.to_string(),
                enabled: true,
            })
        })
        .collect()
}

/// Partes unidas por `&`, como o curl faz com vários `-d`.
fn joined_data(parts: &[DataPart]) -> String {
    parts
        .iter()
        .map(|part| match part {
            DataPart::Text(text) => text.clone(),
            DataPart::UrlEncode(value) => encode_data_urlencode(value),
            DataPart::File(path) => format!("@{path}"),
        })
        .collect::<Vec<_>>()
        .join("&")
}

/// Classifica um corpo textual pelo `Content-Type` ou, sem ele, pelo
/// conteúdo: JSON (ou payload GraphQL), formulário `a=1&b=2` ou texto.
fn text_body(
    text: String,
    headers: &mut Vec<HeaderEntry>,
) -> Result<MappedBody, CollectionImportError> {
    let content_type = headers
        .iter()
        .find(|header| is_content_type(header))
        .map(|header| {
            let value = header.value();
            value
                .split(';')
                .next()
                .unwrap_or(value)
                .trim()
                .to_ascii_lowercase()
        });
    let json = serde_json::from_str::<Value>(&text)
        .ok()
        .filter(|value| value.is_object() || value.is_array());

    if content_type
        .as_deref()
        .is_none_or(|mime| mime.contains("json"))
        && let Some(Value::Object(payload)) = &json
        && let Some((query, variables)) = graphql_payload(payload)?
    {
        // O executor GraphQL já envia `Content-Type: application/json`.
        headers.retain(|header| {
            !is_content_type(header)
                || !header
                    .value()
                    .to_ascii_lowercase()
                    .starts_with("application/json")
        });
        return Ok((ProtocolId::GraphQl, query, variables, BodyPayload::None));
    }

    let raw = |language: RawBodyLanguage| -> Result<MappedBody, CollectionImportError> {
        Ok((
            ProtocolId::Rest,
            text.clone(),
            String::new(),
            BodyPayload::Raw { language },
        ))
    };
    match content_type.as_deref() {
        Some("application/x-www-form-urlencoded") => match form_fields(&text) {
            Some(fields) => Ok(urlencoded_body(fields)),
            None => raw(RawBodyLanguage::Text),
        },
        Some(mime) if json.is_some() && mime.contains("json") => raw(RawBodyLanguage::Json),
        Some(mime) => raw(raw_language_from_mime(mime)),
        None if json.is_some() => {
            ensure_content_type(headers, "application/json")?;
            raw(RawBodyLanguage::Json)
        }
        None => match form_fields(&text) {
            Some(fields) => {
                ensure_content_type(headers, "application/x-www-form-urlencoded")?;
                Ok(urlencoded_body(fields))
            }
            None => raw(RawBodyLanguage::Json),
        },
    }
}

/// `{"query": "…", "variables": {…}}` — o corpo de uma requisição GraphQL.
fn graphql_payload(
    payload: &serde_json::Map<String, Value>,
) -> Result<Option<(String, String)>, CollectionImportError> {
    let Some(Value::String(query)) = payload.get("query") else {
        return Ok(None);
    };
    if !payload
        .keys()
        .all(|key| matches!(key.as_str(), "query" | "variables" | "operationName"))
    {
        return Ok(None);
    }
    let variables = match payload.get("variables") {
        None | Some(Value::Null) => "{}".to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(value) => serde_json::to_string_pretty(value)
            .map_err(|error| CollectionImportError::Invalid(error.to_string()))?,
    };
    Ok(Some((query.clone(), variables)))
}

fn urlencoded_body(fields: Vec<UrlEncodedField>) -> MappedBody {
    let text = fields
        .iter()
        .map(|field| format!("{}={}", field.name, field.value))
        .collect::<Vec<_>>()
        .join("&");
    (
        ProtocolId::Rest,
        text,
        String::new(),
        BodyPayload::UrlEncoded(fields),
    )
}

/// `a=1&b=x+y` decodificado em campos; `None` se o texto não tiver essa forma.
fn form_fields(text: &str) -> Option<Vec<UrlEncodedField>> {
    if text.is_empty() || text.contains(char::is_whitespace) {
        return None;
    }
    text.split('&')
        .map(|pair| {
            let (name, value) = pair.split_once('=')?;
            let name = percent_decode(name, true)?;
            if name.is_empty() {
                return None;
            }
            Some(UrlEncodedField {
                name,
                value: percent_decode(value, true)?,
                enabled: true,
            })
        })
        .collect()
}

fn is_content_type(header: &HeaderEntry) -> bool {
    header.name().eq_ignore_ascii_case("content-type")
}

// ---------------------------------------------------------------------------
// URL e codificação
// ---------------------------------------------------------------------------

/// O curl assume `http://` quando a URL não tem esquema.
fn with_scheme(url: &str) -> String {
    if url.contains("://") || url.starts_with("{{") {
        url.to_string()
    } else {
        format!("http://{url}")
    }
}

fn host_of(url: &str) -> &str {
    let after_scheme = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host)
}

/// `GET /users` — método e caminho, sem query nem host.
fn request_name(method: &str, url: &str) -> String {
    let after_scheme = url.split_once("://").map_or(url, |(_, rest)| rest);
    let path = after_scheme
        .find('/')
        .map_or("/", |start| &after_scheme[start..]);
    let path = path.split(['?', '#']).next().unwrap_or(path);
    format!("{} {}", method.to_ascii_uppercase(), path)
}

fn append_raw_query(url: &mut String, query: &str) {
    url.push(if url.contains('?') { '&' } else { '?' });
    url.push_str(query);
}

/// Codificação do `--data-urlencode`: `nome=valor` codifica só o valor;
/// sem `=` (ou com `=` no início) codifica tudo depois dele.
fn encode_data_urlencode(value: &str) -> String {
    match value.split_once('=') {
        Some(("", content)) => percent_encode(content),
        Some((name, content)) => format!("{name}={}", percent_encode(content)),
        None => percent_encode(value),
    }
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn percent_decode(value: &str, plus_as_space: bool) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        let hex = bytes
            .get(index + 1..index + 3)
            .and_then(|digits| std::str::from_utf8(digits).ok())
            .and_then(|digits| u8::from_str_radix(digits, 16).ok());
        match (byte, hex) {
            (b'%', Some(decoded)) => {
                out.push(decoded);
                index += 3;
                continue;
            }
            (b'+', _) if plus_as_space => out.push(b' '),
            _ => out.push(byte),
        }
        index += 1;
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::HttpMethod;

    fn only_request(raw: &str) -> SavedRequest {
        let imported = parse_shell_commands(raw).unwrap();
        assert_eq!(imported.collections.len(), 1);
        let requests = imported.collections[0].requests();
        assert_eq!(requests.len(), 1);
        requests[0].clone()
    }

    fn header_pairs(request: &SavedRequest) -> Vec<(&str, &str)> {
        request
            .request
            .headers
            .iter()
            .map(|header| (header.name(), header.value()))
            .collect()
    }

    #[test]
    fn does_not_recognize_other_documents() {
        for raw in [
            r#"{"openapi": "3.0.0"}"#,
            "openapi: 3.0.0\ninfo:\n  title: curl",
            "curl: value",
            "",
            "# só comentário",
        ] {
            assert_eq!(
                parse_shell_commands(raw),
                Err(CollectionImportError::NotRecognized),
                "{raw}"
            );
        }
    }

    #[test]
    fn imports_the_curl_generated_for_a_json_request() {
        let raw = "curl --request POST \\\n  --url 'https://api.example.com/users?page=1' \\\n  --header 'Content-Type: application/json' \\\n  --header 'X-Empty;' \\\n  --data-raw '{\n  \"name\": \"Ada'\\''s\"\n}'";

        let imported = parse_shell_commands(raw).unwrap();
        let collection = &imported.collections[0];
        let request = &collection.requests()[0];

        assert_eq!(collection.name(), "api.example.com");
        assert_eq!(request.name(), "POST /users");
        assert_eq!(request.request.method, HttpMethod::Post);
        assert_eq!(
            request.request.endpoint.url(),
            "https://api.example.com/users?page=1"
        );
        assert_eq!(
            header_pairs(request),
            vec![("Content-Type", "application/json"), ("X-Empty", "")]
        );
        assert_eq!(request.request.document.protocol, ProtocolId::Rest);
        assert_eq!(request.request.document.body, "{\n  \"name\": \"Ada's\"\n}");
        assert_eq!(
            request.request.body_payload,
            BodyPayload::Raw {
                language: RawBodyLanguage::Json
            }
        );
    }

    #[test]
    fn imports_the_wget_generated_for_a_json_request() {
        let raw = "wget --quiet \\\n  --method=PUT \\\n  --header='Content-Type: application/json' \\\n  --header='Authorization: Bearer abc' \\\n  --body-data='{\"id\": 1}' \\\n  --output-document=- \\\n  'https://api.example.com/users/1'";

        let request = only_request(raw);

        assert_eq!(request.name(), "PUT /users/1");
        assert_eq!(request.request.method, HttpMethod::Put);
        assert_eq!(
            request.request.endpoint.url(),
            "https://api.example.com/users/1"
        );
        assert_eq!(
            header_pairs(&request),
            vec![
                ("Content-Type", "application/json"),
                ("Authorization", "Bearer abc")
            ]
        );
        assert_eq!(request.request.document.body, "{\"id\": 1}");
        assert_eq!(request.request.authentication, Authentication::None);
    }

    #[test]
    fn maps_a_graphql_payload_back_to_a_graphql_request() {
        let raw = "curl --request POST \\\n  --url 'https://api.example.com/graphql' \\\n  --header 'Content-Type: application/json' \\\n  --data-raw '{\n  \"query\": \"query User($id: ID!) { user(id: $id) { name } }\",\n  \"variables\": {\n    \"id\": \"1\"\n  }\n}'";

        let request = only_request(raw);

        assert_eq!(request.request.document.protocol, ProtocolId::GraphQl);
        assert_eq!(
            request.request.document.body,
            "query User($id: ID!) { user(id: $id) { name } }"
        );
        assert_eq!(request.request.variables, "{\n  \"id\": \"1\"\n}");
        assert!(request.request.headers.is_empty());
    }

    #[test]
    fn imports_curl_urlencoded_and_form_data_bodies() {
        let urlencoded = only_request(
            "curl --request POST --url https://x.dev/login \\\n  --data-urlencode 'user%20name=Ada Lovelace' \\\n  --data-urlencode 'pass=a&b'",
        );
        assert_eq!(
            urlencoded.request.body_payload,
            BodyPayload::UrlEncoded(vec![
                UrlEncodedField {
                    name: "user name".to_string(),
                    value: "Ada Lovelace".to_string(),
                    enabled: true,
                },
                UrlEncodedField {
                    name: "pass".to_string(),
                    value: "a&b".to_string(),
                    enabled: true,
                },
            ])
        );
        assert_eq!(
            header_pairs(&urlencoded),
            vec![("Content-Type", "application/x-www-form-urlencoded")]
        );

        let form = only_request(
            "curl -X POST https://x.dev/upload -H 'Content-Type: multipart/form-data' -F 'file=@/tmp/a b.png;type=image/png' --form-string 'note=x;type=y'",
        );
        assert!(form.request.headers.is_empty());
        assert_eq!(
            form.request.body_payload,
            BodyPayload::FormData(vec![
                FormDataField {
                    name: "file".to_string(),
                    enabled: true,
                    value: FormDataFieldValue::File {
                        file_path: "/tmp/a b.png".to_string()
                    },
                },
                FormDataField {
                    name: "note".to_string(),
                    enabled: true,
                    value: FormDataFieldValue::Text("x;type=y".to_string()),
                },
            ])
        );
    }

    #[test]
    fn imports_wget_urlencoded_and_file_bodies() {
        let urlencoded = only_request(
            "wget --method=POST --body-data='user=Ada+Lovelace&city=S%C3%A3o+Paulo' -O- https://x.dev/login",
        );
        assert_eq!(
            urlencoded.request.body_payload,
            BodyPayload::UrlEncoded(vec![
                UrlEncodedField {
                    name: "user".to_string(),
                    value: "Ada Lovelace".to_string(),
                    enabled: true,
                },
                UrlEncodedField {
                    name: "city".to_string(),
                    value: "São Paulo".to_string(),
                    enabled: true,
                },
            ])
        );

        let binary = only_request("wget --method=POST --body-file='/tmp/data.bin' https://x.dev/");
        assert_eq!(
            binary.request.body_payload,
            BodyPayload::Binary {
                file_path: "/tmp/data.bin".to_string()
            }
        );
        assert_eq!(binary.name(), "POST /");
    }

    #[test]
    fn maps_credentials_to_authentication() {
        let basic = only_request("curl -u 'ada:s3cr:et' https://x.dev/");
        assert_eq!(
            basic.request.authentication,
            Authentication::Basic {
                username: "ada".to_string(),
                password: "s3cr:et".to_string()
            }
        );

        let digest = only_request("curl --digest --user 'ada:pw' https://x.dev/");
        assert!(matches!(
            digest.request.authentication,
            Authentication::Digest { .. }
        ));

        let wget_digest =
            only_request("wget --method=GET --user='ada' --password='pw' https://x.dev/");
        assert_eq!(
            wget_digest.request.authentication,
            Authentication::Digest {
                username: "ada".to_string(),
                password: "pw".to_string()
            }
        );

        let wget_basic = only_request("wget --auth-no-challenge --user=ada --password=pw x.dev");
        assert!(matches!(
            wget_basic.request.authentication,
            Authentication::Basic { .. }
        ));
        assert_eq!(wget_basic.request.endpoint.url(), "http://x.dev");

        let bearer = only_request("curl --oauth2-bearer tok https://x.dev/");
        assert_eq!(
            bearer.request.authentication,
            Authentication::Bearer {
                token: "tok".to_string()
            }
        );
    }

    #[test]
    fn infers_methods_like_curl() {
        assert_eq!(
            only_request("curl https://x.dev/").request.method,
            HttpMethod::Get
        );
        assert_eq!(
            only_request("curl -d a=1 https://x.dev/").request.method,
            HttpMethod::Post
        );
        assert_eq!(
            only_request("curl --head --url https://x.dev/")
                .request
                .method,
            HttpMethod::Head
        );
        assert_eq!(
            only_request("curl -T file.txt https://x.dev/")
                .request
                .method,
            HttpMethod::Put
        );
        assert_eq!(
            only_request("wget --post-data=a=1 https://x.dev/")
                .request
                .method,
            HttpMethod::Post
        );

        let get = only_request("curl -G -d q=1 --data-urlencode 'n=a b' https://x.dev/s");
        assert_eq!(get.request.method, HttpMethod::Get);
        assert_eq!(get.request.endpoint.url(), "https://x.dev/s?q=1&n=a%20b");
        assert_eq!(get.request.body_payload, BodyPayload::None);
    }

    #[test]
    fn reads_short_option_clusters_and_ignores_unrelated_options() {
        let request = only_request(
            "curl -sSLk -XPATCH -o /dev/null -m 10 --compressed -HAccept:\\ text/plain -d'plain text' https://x.dev/a",
        );
        assert_eq!(request.request.method, HttpMethod::Patch);
        assert_eq!(request.request.endpoint.url(), "https://x.dev/a");
        assert_eq!(header_pairs(&request), vec![("Accept", "text/plain")]);
        assert_eq!(request.request.document.body, "plain text");
        assert_eq!(
            request.request.body_payload,
            BodyPayload::Raw {
                language: RawBodyLanguage::Json
            }
        );
    }

    #[test]
    fn reads_double_quotes_ansi_c_quotes_and_comments() {
        let raw = "# OAuth note\n$ curl \"https://x.dev/\\$path\" -H $'X-Line: a\\tb\\u00e9' -H \"Cookie: a=\\\"1\\\"\"";
        let request = only_request(raw);
        assert_eq!(request.request.endpoint.url(), "https://x.dev/$path");
        assert_eq!(
            header_pairs(&request),
            vec![("X-Line", "a\tbé"), ("Cookie", "a=\"1\"")]
        );
    }

    #[test]
    fn imports_several_commands_into_one_collection() {
        let raw = "curl https://x.dev/users | jq .\nwget -q -O- https://x.dev/users\ncurl -X DELETE https://x.dev/users/1 && echo done";
        let imported = parse_shell_commands(raw).unwrap();
        let names: Vec<_> = imported.collections[0]
            .requests()
            .iter()
            .map(SavedRequest::name)
            .collect();
        assert_eq!(
            names,
            vec!["GET /users", "GET /users (2)", "DELETE /users/1"]
        );
    }

    #[test]
    fn keeps_unquoted_ampersands_inside_a_url() {
        let request = only_request("curl https://x.dev/s?a=1&b=2");
        assert_eq!(request.request.endpoint.url(), "https://x.dev/s?a=1&b=2");
    }

    #[test]
    fn rejects_broken_commands() {
        assert!(matches!(
            parse_shell_commands("curl 'https://x.dev/"),
            Err(CollectionImportError::Invalid(_))
        ));
        assert!(matches!(
            parse_shell_commands("curl -X POST"),
            Err(CollectionImportError::Invalid(_))
        ));
        assert!(matches!(
            parse_shell_commands("curl -X TRACE https://x.dev/"),
            Err(CollectionImportError::Invalid(_))
        ));
    }
}
