//! Modo Sistema. No Windows, a configuração de proxy do usuário
//! (Configurações > Rede > Proxy) é interpretada aqui, e não pelo `reqwest`,
//! que lê o registro só ao construir o cliente, não entende o formato por
//! protocolo (`http=host:porta;https=host:porta`), ignora `<local>` e não usa
//! o script de configuração.

use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::{ClientBuilder, Proxy, Url};

use crate::client::download_pac;
use crate::pac::PacScript;

/// Espera antes de tentar de novo um script de configuração que falhou.
const SCRIPT_RETRY: Duration = Duration::from_secs(60);

/// Flags de `DefaultConnectionSettings` (as de `INTERNET_PER_CONN_FLAGS`).
const PROXY_TYPE_PROXY: u32 = 0x02;
const PROXY_TYPE_AUTO_PROXY_URL: u32 = 0x04;

/// Configuração de proxy do sistema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SystemProxy {
    /// Comportamento nativo do `reqwest`: variáveis de ambiente (e, no macOS,
    /// a configuração do sistema).
    Native,
    #[cfg_attr(not(windows), allow(dead_code))]
    Windows(WindowsProxy),
}

impl SystemProxy {
    /// Lê a configuração atual. No Windows, variáveis de ambiente de proxy,
    /// quando definidas, têm precedência (como no comportamento nativo).
    pub(crate) fn current() -> Self {
        #[cfg(windows)]
        if !env_proxy_configured() {
            return Self::Windows(WindowsProxy::from_registry());
        }
        Self::Native
    }

    fn script_url(&self) -> Option<&str> {
        match self {
            Self::Native => None,
            Self::Windows(windows) => windows.script_url.as_deref(),
        }
    }
}

/// Configuração de proxy do usuário no Windows.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct WindowsProxy {
    /// "Usar um servidor proxy".
    pub manual: ManualProxy,
    /// "Usar script de configuração": URL do script PAC.
    pub script_url: Option<String>,
}

impl WindowsProxy {
    #[cfg(windows)]
    fn from_registry() -> Self {
        let Ok(key) = windows_registry::CURRENT_USER
            .open(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        else {
            return Self::default();
        };
        // A configuração vigente fica em `DefaultConnectionSettings`; os
        // valores avulsos são espelhos legados, lidos só se ela faltar.
        if let Some(settings) = key
            .open("Connections")
            .and_then(|connections| connections.get_value("DefaultConnectionSettings"))
            .ok()
            .and_then(|blob| parse_connection_settings(&blob))
        {
            return settings;
        }
        Self {
            manual: ManualProxy {
                enabled: key.get_u32("ProxyEnable").unwrap_or(0) != 0,
                server: key.get_string("ProxyServer").unwrap_or_default(),
                bypass: key.get_string("ProxyOverride").unwrap_or_default(),
            },
            script_url: key
                .get_string("AutoConfigURL")
                .ok()
                .map(|url| url.trim().to_string())
                .filter(|url| !url.is_empty()),
        }
    }
}

/// Lê `DefaultConnectionSettings`: depois de dois DWORDs (versão e contador),
/// vêm as flags e três strings prefixadas pelo tamanho (servidor, exceções e
/// URL do script), tudo little-endian.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_connection_settings(blob: &[u8]) -> Option<WindowsProxy> {
    let flags = read_u32(blob, 8)?;
    let mut offset = 12;
    let mut next_string = || -> Option<String> {
        let len = usize::try_from(read_u32(blob, offset)?).ok()?;
        let start = offset + 4;
        let bytes = blob.get(start..start.checked_add(len)?)?;
        offset = start + len;
        Some(String::from_utf8_lossy(bytes).into_owned())
    };
    let server = next_string()?;
    let bypass = next_string()?;
    let script = next_string()?;

    let script = script.trim();
    Some(WindowsProxy {
        manual: ManualProxy {
            enabled: flags & PROXY_TYPE_PROXY != 0,
            server,
            bypass,
        },
        script_url: (flags & PROXY_TYPE_AUTO_PROXY_URL != 0 && !script.is_empty())
            .then(|| script.to_string()),
    })
}

#[cfg_attr(not(windows), allow(dead_code))]
fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let chunk = bytes.get(offset..offset.checked_add(4)?)?;
    Some(u32::from_le_bytes(chunk.try_into().ok()?))
}

/// Proxy do sistema com que um cliente foi construído, com o script de
/// configuração (quando houver) já baixado.
#[derive(Clone)]
pub(crate) struct SystemState {
    settings: SystemProxy,
    script: Script,
}

#[derive(Clone)]
enum Script {
    NotConfigured,
    /// Ainda não baixado (ver `SystemState::load_script`).
    Pending,
    Loaded(Arc<PacScript>),
    /// Falhou; enquanto isso vale o proxy manual.
    Failed(Instant),
}

impl SystemState {
    /// Lê a configuração atual, sem I/O de rede: o script de `previous` é
    /// reaproveitado se a URL não mudou; senão fica pendente.
    pub(crate) fn capture(previous: Option<&SystemState>) -> Self {
        Self::with_settings(SystemProxy::current(), previous)
    }

    fn with_settings(settings: SystemProxy, previous: Option<&SystemState>) -> Self {
        let script = match settings.script_url() {
            None => Script::NotConfigured,
            Some(url) => previous
                .filter(|previous| previous.settings.script_url() == Some(url))
                .map_or(Script::Pending, |previous| previous.script.clone()),
        };
        Self { settings, script }
    }

    /// Precisa ser recapturado: a configuração mudou, o script não foi
    /// baixado ou falhou há mais de `SCRIPT_RETRY`.
    pub(crate) fn is_stale(&self) -> bool {
        match self.script {
            Script::Pending => true,
            Script::Failed(at) if at.elapsed() >= SCRIPT_RETRY => true,
            _ => self.settings != SystemProxy::current(),
        }
    }

    /// Baixa o script pendente (ou que falhou), sem passar por proxy.
    pub(crate) async fn load_script(mut self) -> Self {
        if let Some(url) = self.settings.script_url()
            && matches!(self.script, Script::Pending | Script::Failed(_))
        {
            self.script = match download_pac(url).await.and_then(PacScript::new) {
                Ok(script) => Script::Loaded(Arc::new(script)),
                Err(_) => Script::Failed(Instant::now()),
            };
        }
        self
    }

    pub(crate) fn apply(&self, builder: ClientBuilder) -> ClientBuilder {
        let SystemProxy::Windows(windows) = &self.settings else {
            return builder;
        };
        // Como no Windows, o script prevalece sobre o proxy manual, que fica
        // como alternativa quando o script não pôde ser baixado.
        if let Script::Loaded(script) = &self.script {
            let script = Arc::clone(script);
            return builder
                .no_proxy()
                .proxy(Proxy::custom(move |url| script.proxy_for(url)));
        }
        if !windows.manual.enabled {
            return builder.no_proxy();
        }
        let manual = windows.manual.clone();
        builder
            .no_proxy()
            .proxy(Proxy::custom(move |url| manual.proxy_for(url)))
    }
}

/// Valores de "Usar um servidor proxy".
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct ManualProxy {
    pub enabled: bool,
    /// `host:porta` para todos os protocolos, ou `http=host:porta;https=host:porta`.
    pub server: String,
    /// Exceções separadas por `;`, com `*` e `<local>`.
    pub bypass: String,
}

impl ManualProxy {
    /// Proxy para `url`; `None` significa conexão direta.
    pub(crate) fn proxy_for(&self, url: &Url) -> Option<Url> {
        if !self.enabled {
            return None;
        }
        let host = url.host_str()?;
        let host = host.trim_start_matches('[').trim_end_matches(']');
        if self.bypasses(host) {
            return None;
        }
        let entry = server_for_scheme(&self.server, url.scheme())?;
        let proxy = if entry.contains("://") {
            Url::parse(entry)
        } else {
            Url::parse(&format!("http://{entry}"))
        }
        .ok()?;
        matches!(proxy.scheme(), "http" | "https").then_some(proxy)
    }

    fn bypasses(&self, host: &str) -> bool {
        let entries: Vec<&str> = self
            .bypass
            .split(';')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .collect();
        let is_ip = host.parse::<std::net::IpAddr>().is_ok();

        // Como no Windows, loopback não passa pelo proxy, a menos que a
        // lista traga `<-loopback>`.
        if is_loopback(host)
            && !entries
                .iter()
                .any(|entry| entry.eq_ignore_ascii_case("<-loopback>"))
        {
            return true;
        }

        let host = host.to_ascii_lowercase();
        entries.iter().any(|entry| {
            if entry.eq_ignore_ascii_case("<local>") {
                return !is_ip && !host.contains('.');
            }
            let pattern = entry.split_once("://").map_or(*entry, |(_, rest)| rest);
            wildcard_match(&pattern.to_ascii_lowercase(), &host)
        })
    }
}

/// Entrada de `ProxyServer` para o protocolo do destino.
fn server_for_scheme<'a>(server: &'a str, scheme: &str) -> Option<&'a str> {
    let mut entries = server
        .split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty());
    if !server.contains('=') {
        return entries.next();
    }
    entries
        .filter_map(|entry| entry.split_once('='))
        .find(|(protocol, _)| protocol.trim().eq_ignore_ascii_case(scheme))
        .map(|(_, target)| target.trim())
        .filter(|target| !target.is_empty())
}

fn is_loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// `*` casa qualquer sequência (inclusive vazia); o resto é literal.
fn wildcard_match(pattern: &str, text: &str) -> bool {
    let mut parts = pattern.split('*');
    let first = parts.next().unwrap_or_default();
    let Some(mut rest) = text.strip_prefix(first) else {
        return false;
    };
    let parts: Vec<&str> = parts.collect();
    let Some((last, middle)) = parts.split_last() else {
        return rest.is_empty();
    };
    for part in middle {
        match rest.find(part) {
            Some(index) => rest = &rest[index + part.len()..],
            None => return false,
        }
    }
    rest.ends_with(last)
}

#[cfg(windows)]
fn env_proxy_configured() -> bool {
    [
        "ALL_PROXY",
        "all_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ]
    .iter()
    .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn manual(server: &str, bypass: &str) -> ManualProxy {
        ManualProxy {
            enabled: true,
            server: server.into(),
            bypass: bypass.into(),
        }
    }

    fn proxy_for(proxy: &ManualProxy, url: &str) -> Option<String> {
        proxy
            .proxy_for(&Url::parse(url).unwrap())
            .map(|proxy| proxy.to_string())
    }

    #[test]
    fn a_single_server_applies_to_every_scheme() {
        let proxy = manual("proxy.corp:3128", "");
        assert_eq!(
            proxy_for(&proxy, "http://api.example.com/graphql").as_deref(),
            Some("http://proxy.corp:3128/")
        );
        assert_eq!(
            proxy_for(&proxy, "https://api.example.com/graphql").as_deref(),
            Some("http://proxy.corp:3128/")
        );
    }

    #[test]
    fn per_protocol_servers_are_chosen_by_the_destination_scheme() {
        let proxy = manual(
            "http=127.0.0.1:8888;https=127.0.0.1:8889;socks=10.0.0.1:1080",
            "",
        );
        assert_eq!(
            proxy_for(&proxy, "http://api.example.com/").as_deref(),
            Some("http://127.0.0.1:8888/")
        );
        assert_eq!(
            proxy_for(&proxy, "https://api.example.com/").as_deref(),
            Some("http://127.0.0.1:8889/")
        );

        let http_only = manual("http=127.0.0.1:8888", "");
        assert_eq!(proxy_for(&http_only, "https://api.example.com/"), None);
    }

    #[test]
    fn a_disabled_proxy_or_an_unusable_server_goes_direct() {
        let mut disabled = manual("proxy.corp:3128", "");
        disabled.enabled = false;
        assert_eq!(proxy_for(&disabled, "https://api.example.com/"), None);
        assert_eq!(proxy_for(&manual("", ""), "https://api.example.com/"), None);
        assert_eq!(
            proxy_for(
                &manual("socks5://10.0.0.1:1080", ""),
                "https://api.example.com/"
            ),
            None
        );
    }

    #[test]
    fn loopback_is_bypassed_unless_the_list_opts_in() {
        let proxy = manual("proxy.corp:3128", "");
        assert_eq!(proxy_for(&proxy, "http://localhost:4000/"), None);
        assert_eq!(proxy_for(&proxy, "http://127.0.0.1:4000/"), None);
        assert_eq!(proxy_for(&proxy, "http://[::1]:4000/"), None);

        let opted_in = manual("proxy.corp:3128", "<-loopback>");
        assert!(proxy_for(&opted_in, "http://localhost:4000/").is_some());
    }

    #[test]
    fn bypass_list_supports_local_and_wildcards() {
        let proxy = manual(
            "proxy.corp:3128",
            "<local>;*.intranet.corp;10.*;API.Internal",
        );
        assert_eq!(proxy_for(&proxy, "http://intranet/"), None);
        assert_eq!(proxy_for(&proxy, "https://wiki.intranet.corp/"), None);
        assert_eq!(proxy_for(&proxy, "http://10.1.2.3/"), None);
        assert_eq!(proxy_for(&proxy, "https://api.internal/"), None);

        assert!(proxy_for(&proxy, "https://intranet.corp/").is_some());
        assert!(proxy_for(&proxy, "https://api.example.com/").is_some());
        assert!(proxy_for(&proxy, "http://192.168.0.1/").is_some());
    }

    #[test]
    fn wildcards_match_any_sequence() {
        assert!(wildcard_match("*", "anything"));
        assert!(wildcard_match("*.corp", "a.b.corp"));
        assert!(!wildcard_match("*.corp", "corp"));
        assert!(wildcard_match("192.168.*.1", "192.168.10.1"));
        assert!(!wildcard_match("192.168.*.1", "192.168.10.2"));
        assert!(wildcard_match("exact.host", "exact.host"));
        assert!(!wildcard_match("exact.host", "exact.host.evil"));
    }

    fn windows(manual: ManualProxy, script_url: Option<String>) -> SystemProxy {
        SystemProxy::Windows(WindowsProxy { manual, script_url })
    }

    fn connection_settings(flags: u32, server: &str, bypass: &str, script: &str) -> Vec<u8> {
        let mut blob = Vec::new();
        blob.extend_from_slice(&0x46u32.to_le_bytes());
        blob.extend_from_slice(&7u32.to_le_bytes());
        blob.extend_from_slice(&flags.to_le_bytes());
        for text in [server, bypass, script] {
            blob.extend_from_slice(&u32::try_from(text.len()).unwrap().to_le_bytes());
            blob.extend_from_slice(text.as_bytes());
        }
        // Campos seguintes (detecção automática) são ignorados.
        blob.extend_from_slice(&[0; 32]);
        blob
    }

    #[test]
    fn connection_settings_flags_decide_what_is_enabled() {
        let both = parse_connection_settings(&connection_settings(
            0x01 | 0x02 | 0x04,
            "proxy.corp:3128",
            "<local>",
            " http://corp/proxy.pac ",
        ))
        .unwrap();
        assert_eq!(both.manual, manual("proxy.corp:3128", "<local>"));
        assert_eq!(both.script_url.as_deref(), Some("http://corp/proxy.pac"));

        // Script desligado: a URL continua guardada, mas não vale.
        let manual_only = parse_connection_settings(&connection_settings(
            0x01 | 0x02,
            "proxy.corp:3128",
            "",
            "http://corp/proxy.pac",
        ))
        .unwrap();
        assert!(manual_only.manual.enabled);
        assert_eq!(manual_only.script_url, None);

        let direct =
            parse_connection_settings(&connection_settings(0x01, "proxy.corp:3128", "", ""))
                .unwrap();
        assert!(!direct.manual.enabled);
        assert_eq!(direct.script_url, None);

        let truncated = connection_settings(0x03, "proxy.corp:3128", "", "");
        assert_eq!(parse_connection_settings(&truncated[..20]), None);
    }

    #[test]
    fn the_downloaded_script_is_reused_while_its_url_is_unchanged() {
        let script =
            PacScript::new(r#"function FindProxyForURL(url, host) { return "DIRECT"; }"#).unwrap();
        let url = "http://corp/proxy.pac".to_string();
        let previous = SystemState {
            settings: windows(ManualProxy::default(), Some(url.clone())),
            script: Script::Loaded(Arc::new(script)),
        };

        // Mudou só o proxy manual: o script segue carregado.
        let same = SystemState::with_settings(
            windows(manual("proxy.corp:3128", ""), Some(url)),
            Some(&previous),
        );
        assert!(matches!(same.script, Script::Loaded(_)));

        let other = SystemState::with_settings(
            windows(ManualProxy::default(), Some("http://corp/other.pac".into())),
            Some(&previous),
        );
        assert!(matches!(other.script, Script::Pending));

        let none =
            SystemState::with_settings(windows(ManualProxy::default(), None), Some(&previous));
        assert!(matches!(none.script, Script::NotConfigured));
    }

    /// Servidor de teste que faz as vezes de proxy (um proxy HTTP recebe a
    /// URL absoluta, que o wiremock casa por caminho).
    async fn proxy_server() -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/via-proxy"))
            .respond_with(ResponseTemplate::new(200).set_body_string("proxied"))
            .mount(&server)
            .await;
        server
    }

    async fn fetch_through(system: &SystemState) -> Result<String, reqwest::Error> {
        let client = system.apply(reqwest::Client::builder()).build()?;
        client
            .get("http://destino.invalido.test/via-proxy")
            .send()
            .await?
            .text()
            .await
    }

    #[tokio::test]
    async fn the_configuration_script_takes_precedence_over_the_manual_proxy() {
        let server = proxy_server().await;
        let address = server.address().to_string();
        Mock::given(method("GET"))
            .and(path("/proxy.pac"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"function FindProxyForURL(url, host) {{ return "PROXY {address}"; }}"#
            )))
            .mount(&server)
            .await;

        // O proxy manual não existe: se fosse usado, a requisição falharia.
        let settings = windows(
            manual("127.0.0.1:9", ""),
            Some(format!("{}/proxy.pac", server.uri())),
        );
        let system = SystemState::with_settings(settings, None)
            .load_script()
            .await;

        assert!(matches!(system.script, Script::Loaded(_)));
        assert_eq!(fetch_through(&system).await.unwrap(), "proxied");
    }

    #[tokio::test]
    async fn an_unreachable_script_falls_back_to_the_manual_proxy() {
        let server = proxy_server().await;
        let settings = windows(
            manual(&server.address().to_string(), ""),
            Some(format!("{}/sem-script.pac", server.uri())),
        );
        let system = SystemState::with_settings(settings, None)
            .load_script()
            .await;

        assert!(matches!(system.script, Script::Failed(_)));
        assert_eq!(fetch_through(&system).await.unwrap(), "proxied");
    }
}
