//! Avaliação de scripts PAC (`FindProxyForURL`) com `boa_engine`.

use std::collections::HashMap;
use std::net::{IpAddr, ToSocketAddrs, UdpSocket};
use std::sync::Mutex;

use boa_engine::{Context, JsResult, JsString, JsValue, NativeFunction, Source};
use reqwest::Url;

use crate::client::ProxyError;

const LOOP_ITERATION_LIMIT: u64 = 1_000_000;
const RECURSION_LIMIT: usize = 400;
const STACK_SIZE_LIMIT: usize = 4_096;
const MAX_PAC_SOURCE_BYTES: usize = 1024 * 1024;
const MAX_PAC_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_CACHED_DESTINATIONS: usize = 512;
const PROBE_URL: &str = "http://example.com/";

/// Funções auxiliares padrão de PAC escritas em JS puro; `dnsResolve` e
/// `myIpAddress` são nativas (registradas antes do prelúdio).
const PRELUDE: &str = r#"
function isPlainHostName(host) { return host.indexOf('.') === -1; }
function dnsDomainIs(host, domain) {
  return host.length >= domain.length && host.substring(host.length - domain.length) === domain;
}
function localHostOrDomainIs(host, hostdom) {
  return host === hostdom || hostdom.lastIndexOf(host + '.', 0) === 0;
}
function dnsDomainLevels(host) { return host.split('.').length - 1; }
function isResolvable(host) { return dnsResolve(host) !== null; }
function shExpMatch(str, shexp) {
  var re = '^' + String(shexp).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
  return new RegExp(re).test(str);
}
function __ip(text) {
  var m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text || '');
  if (!m) return null;
  return ((+m[1] * 256 + +m[2]) * 256 + +m[3]) * 256 + +m[4];
}
function isInNet(host, pattern, mask) {
  var ip = __ip(/^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : dnsResolve(host));
  var net = __ip(pattern), m = __ip(mask);
  if (ip === null || net === null || m === null) return false;
  for (var i = 0; i < 4; i++) {
    var shift = Math.pow(2, 8 * (3 - i));
    var a = Math.floor(ip / shift) % 256, b = Math.floor(net / shift) % 256, c = Math.floor(m / shift) % 256;
    if ((a & c) !== (b & c)) return false;
  }
  return true;
}
function weekdayRange(a, b, gmt) {
  var days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  var now = new Date();
  var d = gmt === 'GMT' || b === 'GMT' ? now.getUTCDay() : now.getDay();
  var from = days.indexOf(a);
  var to = b && b !== 'GMT' ? days.indexOf(b) : from;
  return from <= to ? d >= from && d <= to : d >= from || d <= to;
}
function timeRange() { return true; }
function dateRange() { return true; }
"#;

/// Uma das alternativas devolvidas por `FindProxyForURL`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PacDirective {
    Direct,
    /// URL do proxy (`http://host:porta` ou `https://host:porta`).
    Proxy(String),
    /// Alternativa que o Alcy não sabe usar (ex.: SOCKS).
    Unsupported(String),
}

/// Script PAC já validado, com cache do resultado por destino.
pub struct PacScript {
    source: String,
    cache: Mutex<HashMap<String, Vec<PacDirective>>>,
}

impl PacScript {
    /// Valida o script (define `FindProxyForURL` e responde a uma consulta de
    /// teste) antes de aceitá-lo.
    pub fn new(source: impl Into<String>) -> Result<Self, ProxyError> {
        let source = source.into();
        if source.len() > MAX_PAC_SOURCE_BYTES {
            return Err(ProxyError::PacInvalid(format!(
                "script PAC excede o limite de {} MiB",
                MAX_PAC_SOURCE_BYTES / (1024 * 1024)
            )));
        }
        let script = Self {
            source,
            cache: Mutex::new(HashMap::new()),
        };
        let probe =
            Url::parse(PROBE_URL).map_err(|error| ProxyError::PacInvalid(error.to_string()))?;
        script.evaluate(&probe).map_err(ProxyError::PacInvalid)?;
        Ok(script)
    }

    /// Alternativas para `url`, na ordem do script. Erros de avaliação em
    /// tempo de uso viram conexão direta (não bloqueiam a requisição).
    pub fn directives_for(&self, url: &Url) -> Vec<PacDirective> {
        let key = url.as_str().to_string();
        if let Ok(cache) = self.cache.lock()
            && let Some(hit) = cache.get(&key)
        {
            return hit.clone();
        }

        let directives = self
            .evaluate(url)
            .unwrap_or_else(|_| vec![PacDirective::Direct]);

        if let Ok(mut cache) = self.cache.lock() {
            if cache.len() >= MAX_CACHED_DESTINATIONS {
                cache.clear();
            }
            cache.insert(key, directives.clone());
        }
        directives
    }

    /// URL do primeiro proxy utilizável; `None` significa conexão direta.
    pub fn proxy_for(&self, url: &Url) -> Option<Url> {
        for directive in self.directives_for(url) {
            match directive {
                PacDirective::Direct => return None,
                PacDirective::Proxy(proxy) => {
                    if let Ok(parsed) = Url::parse(&proxy) {
                        return Some(parsed);
                    }
                }
                PacDirective::Unsupported(_) => {}
            }
        }
        None
    }

    fn evaluate(&self, url: &Url) -> Result<Vec<PacDirective>, String> {
        let mut context = Context::default();
        context
            .runtime_limits_mut()
            .set_loop_iteration_limit(LOOP_ITERATION_LIMIT);
        context
            .runtime_limits_mut()
            .set_recursion_limit(RECURSION_LIMIT);
        context
            .runtime_limits_mut()
            .set_stack_size_limit(STACK_SIZE_LIMIT);

        context
            .register_global_callable(
                JsString::from("dnsResolve"),
                1,
                NativeFunction::from_fn_ptr(dns_resolve),
            )
            .map_err(|error| error.to_string())?;
        context
            .register_global_callable(
                JsString::from("myIpAddress"),
                0,
                NativeFunction::from_fn_ptr(my_ip_address),
            )
            .map_err(|error| error.to_string())?;

        context
            .eval(Source::from_bytes(PRELUDE))
            .map_err(|error| error.to_string())?;
        context
            .eval(Source::from_bytes(&self.source))
            .map_err(|error| error.to_string())?;

        let host = url.host_str().unwrap_or_default();
        let call = format!(
            "FindProxyForURL({}, {})",
            serde_json::Value::String(url.as_str().to_string()),
            serde_json::Value::String(host.to_string()),
        );
        let value = context
            .eval(Source::from_bytes(&call))
            .map_err(|error| error.to_string())?;
        let text = value
            .to_string(&mut context)
            .map_err(|error| error.to_string())?
            .to_std_string_escaped();
        if text.len() > MAX_PAC_OUTPUT_BYTES {
            return Err(format!(
                "resultado PAC excede o limite de {} KiB",
                MAX_PAC_OUTPUT_BYTES / 1024
            ));
        }

        Ok(parse_directives(&text))
    }
}

fn parse_directives(text: &str) -> Vec<PacDirective> {
    let mut directives: Vec<PacDirective> = text
        .split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            let mut parts = entry.split_whitespace();
            let kind = parts.next().unwrap_or_default().to_ascii_uppercase();
            let target = parts.next().unwrap_or_default();
            match kind.as_str() {
                "DIRECT" => PacDirective::Direct,
                "PROXY" | "HTTP" if !target.is_empty() => {
                    PacDirective::Proxy(format!("http://{target}"))
                }
                "HTTPS" if !target.is_empty() => PacDirective::Proxy(format!("https://{target}")),
                _ => PacDirective::Unsupported(entry.to_string()),
            }
        })
        .collect();
    if directives.is_empty() {
        directives.push(PacDirective::Direct);
    }
    directives
}

fn dns_resolve(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let host = match args.first() {
        Some(value) => value.to_string(context)?.to_std_string_escaped(),
        None => return Ok(JsValue::null()),
    };
    let resolved = (host.as_str(), 0)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| addresses.find(|address| address.is_ipv4()))
        .map(|address| address.ip().to_string());
    Ok(match resolved {
        Some(ip) => JsValue::from(JsString::from(ip.as_str())),
        None => JsValue::null(),
    })
}

fn my_ip_address(_: &JsValue, _: &[JsValue], _: &mut Context) -> JsResult<JsValue> {
    // "Conectar" um socket UDP só escolhe a interface de saída; nenhum
    // pacote é enviado.
    let local = UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| socket.connect("192.0.2.1:9").map(|_| socket))
        .and_then(|socket| socket.local_addr())
        .map(|address| address.ip())
        .unwrap_or(IpAddr::from([127, 0, 0, 1]));
    Ok(JsValue::from(JsString::from(local.to_string().as_str())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn direct_and_proxy_answers() {
        let script = PacScript::new(
            r#"function FindProxyForURL(url, host) {
                 if (dnsDomainIs(host, ".internal")) return "DIRECT";
                 return "PROXY proxy.corp:8080";
               }"#,
        )
        .unwrap();

        assert_eq!(script.proxy_for(&url("https://api.internal/x")), None);
        assert_eq!(
            script.proxy_for(&url("https://example.org/")),
            Some(url("http://proxy.corp:8080"))
        );
    }

    #[test]
    fn falls_back_through_the_list_and_skips_unsupported() {
        let script = PacScript::new(
            r#"function FindProxyForURL() { return "SOCKS5 s:1080; HTTPS secure:443; DIRECT"; }"#,
        )
        .unwrap();
        assert_eq!(
            script.directives_for(&url("http://a.test/")),
            vec![
                PacDirective::Unsupported("SOCKS5 s:1080".into()),
                PacDirective::Proxy("https://secure:443".into()),
                PacDirective::Direct,
            ]
        );
        assert_eq!(
            script.proxy_for(&url("http://a.test/")),
            Some(url("https://secure:443"))
        );

        let only_socks =
            PacScript::new(r#"function FindProxyForURL() { return "SOCKS s:1"; }"#).unwrap();
        assert_eq!(only_socks.proxy_for(&url("http://a.test/")), None);
    }

    #[test]
    fn helpers_match_patterns_and_networks() {
        let script = PacScript::new(
            r#"function FindProxyForURL(url, host) {
                 if (isPlainHostName(host)) return "DIRECT";
                 if (shExpMatch(host, "*.example.com")) return "PROXY a:1";
                 if (isInNet(host, "10.0.0.0", "255.0.0.0")) return "PROXY b:2";
                 return "PROXY c:3";
               }"#,
        )
        .unwrap();
        assert_eq!(script.proxy_for(&url("http://intranet/")), None);
        assert_eq!(
            script.proxy_for(&url("http://www.example.com/")),
            Some(url("http://a:1"))
        );
        assert_eq!(
            script.proxy_for(&url("http://10.1.2.3/")),
            Some(url("http://b:2"))
        );
        assert_eq!(
            script.proxy_for(&url("http://192.168.1.1/")),
            Some(url("http://c:3"))
        );
    }

    #[test]
    fn rejects_scripts_without_the_entry_point_or_with_errors() {
        assert!(matches!(
            PacScript::new("var x = 1;"),
            Err(ProxyError::PacInvalid(_))
        ));
        assert!(matches!(
            PacScript::new("function FindProxyForURL( {"),
            Err(ProxyError::PacInvalid(_))
        ));
        assert!(matches!(
            PacScript::new("function FindProxyForURL() { while (true) {} }"),
            Err(ProxyError::PacInvalid(_))
        ));
    }

    #[test]
    fn rejects_oversized_source_and_output() {
        let source = " ".repeat(MAX_PAC_SOURCE_BYTES + 1);
        assert!(matches!(
            PacScript::new(source),
            Err(ProxyError::PacInvalid(message)) if message.contains("script PAC excede")
        ));

        let source = format!(
            "function FindProxyForURL() {{ return 'x'.repeat({}); }}",
            MAX_PAC_OUTPUT_BYTES + 1
        );
        assert!(matches!(
            PacScript::new(source),
            Err(ProxyError::PacInvalid(message)) if message.contains("resultado PAC excede")
        ));
    }
}
