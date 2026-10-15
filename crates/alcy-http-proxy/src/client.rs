use std::sync::{Arc, RwLock};
use std::time::Duration;

use alcy_domain::{ProxySettings, RedirectPolicy};
use reqwest::{Client, Proxy};
use thiserror::Error;

use crate::pac::PacScript;
use crate::system::SystemState;

const PAC_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_PAC_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ProxyError {
    #[error("falha ao baixar o script de configuração automática: {0}")]
    PacDownload(String),
    #[error("script de configuração automática inválido: {0}")]
    PacInvalid(String),
    #[error("falha ao construir o cliente HTTP: {0}")]
    ClientBuild(String),
    #[error("CA personalizada inválida: {0}")]
    CustomCa(String),
}

/// `ProxySettings` já resolvido: para PAC, o script foi baixado e validado.
#[derive(Clone)]
pub enum ProxyPlan {
    Disabled,
    System,
    Pac(Arc<PacScript>),
}

impl ProxyPlan {
    /// Materializa a configuração; só o modo PAC faz I/O (download do script,
    /// sem passar por proxy).
    pub async fn resolve(settings: &ProxySettings) -> Result<Self, ProxyError> {
        match settings {
            ProxySettings::Disabled => Ok(Self::Disabled),
            ProxySettings::System => Ok(Self::System),
            ProxySettings::Pac { url } => {
                let source = download_pac(url).await?;
                Ok(Self::Pac(Arc::new(PacScript::new(source)?)))
            }
        }
    }

    /// Proxy for a connection to `url`, for clients that do not go through
    /// `SharedHttpClient` (gRPC, spec 0129); `None` connects directly. The
    /// system mode reads the current configuration on every call.
    pub async fn proxy_for(&self, url: &reqwest::Url) -> Option<reqwest::Url> {
        match self {
            Self::Disabled => None,
            Self::Pac(script) => script.proxy_for(url),
            Self::System => SystemState::capture(None)
                .load_script()
                .await
                .proxy_for(url),
        }
    }
}

pub(crate) async fn download_pac(url: &str) -> Result<String, ProxyError> {
    let client = Client::builder()
        .timeout(PAC_DOWNLOAD_TIMEOUT)
        .no_proxy()
        .build()
        .map_err(|error| ProxyError::ClientBuild(error.to_string()))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| ProxyError::PacDownload(error.to_string()))?;

    if !response.status().is_success() {
        return Err(ProxyError::PacDownload(format!(
            "resposta HTTP {}",
            response.status()
        )));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|error| ProxyError::PacDownload(error.to_string()))?;
    if bytes.len() > MAX_PAC_BYTES {
        return Err(ProxyError::PacDownload(
            "script maior que o limite de 1 MB".into(),
        ));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Constrói o cliente HTTP compartilhado pelos executores. Sem `timeout`,
/// as chamadas esperam indefinidamente. `system` é o proxy do sistema (só no
/// modo Sistema).
fn build(
    timeout: Option<Duration>,
    plan: &ProxyPlan,
    system: Option<&SystemState>,
    redirect_policy: RedirectPolicy,
    custom_ca_certificates: &[reqwest::Certificate],
    accept_invalid_certificates: bool,
) -> Result<Client, ProxyError> {
    let builder = Client::builder()
        // Habilita o extension `TlsInfo` na resposta (ver `alcy_domain::ConnectionInfo`);
        // sem isso, `response.extensions()` nunca carrega o certificado de peer.
        .tls_info(true);
    // Único ponto revisado que desliga a verificação de certificado (ADR 0058).
    // Com rustls, isso também deixa de conferir o hostname. Só os executores
    // de chamadas do usuário ligam o flag; o padrão é verificar.
    let builder = if accept_invalid_certificates {
        builder.danger_accept_invalid_certs(true)
    } else {
        builder
    };
    let builder = custom_ca_certificates
        .iter()
        .cloned()
        .fold(builder, |builder, certificate| {
            builder.add_root_certificate(certificate)
        });
    let builder = match timeout {
        Some(timeout) => builder.timeout(timeout),
        None => builder,
    };

    let builder = match (plan, system) {
        (ProxyPlan::Disabled, _) => builder.no_proxy(),
        // Registro (Windows, ver `system.rs`), configuração do sistema (macOS)
        // e variáveis de ambiente.
        (ProxyPlan::System, Some(system)) => system.apply(builder),
        (ProxyPlan::System, None) => builder,
        (ProxyPlan::Pac(script), _) => {
            let script = Arc::clone(script);
            builder
                .no_proxy()
                .proxy(Proxy::custom(move |url| script.proxy_for(url)))
        }
    };

    let builder = match redirect_policy {
        RedirectPolicy::Follow => builder,
        RedirectPolicy::Manual => builder.redirect(reqwest::redirect::Policy::none()),
    };

    builder
        .build()
        .map_err(|error| ProxyError::ClientBuild(error.to_string()))
}

/// Cliente usado numa execução, com a configuração de TLS com que foi
/// construído (lida sob o mesmo lock, para a resposta refletir o cliente que
/// de fato enviou a requisição).
pub struct RequestClient {
    pub client: Client,
    pub accepts_invalid_certificates: bool,
}

/// Cliente HTTP que pode ser trocado em runtime (nova configuração de
/// proxy ou de timeout) sem recriar o executor que o usa.
pub struct SharedHttpClient {
    state: RwLock<ClientState>,
}

struct ClientState {
    timeout: Option<Duration>,
    plan: ProxyPlan,
    client: Client,
    manual_redirect_client: Client,
    custom_ca_certificates: Vec<reqwest::Certificate>,
    accept_invalid_certificates: bool,
    /// Proxy do sistema com que `client` foi construído (só no modo Sistema).
    system: Option<SystemState>,
}

impl SharedHttpClient {
    pub fn new(timeout: Duration) -> Self {
        let client = build(
            Some(timeout),
            &ProxyPlan::Disabled,
            None,
            RedirectPolicy::Follow,
            &[],
            false,
        )
        // Só falha por erro de inicialização do backend TLS do sistema,
        // o que não acontece com a configuração padrão usada aqui.
        .expect("cliente HTTP com configuração padrão deveria ser construído com sucesso");
        let manual_redirect_client = build(
            Some(timeout),
            &ProxyPlan::Disabled,
            None,
            RedirectPolicy::Manual,
            &[],
            false,
        )
        .expect("cliente HTTP com configuração padrão deveria ser construído com sucesso");
        Self {
            state: RwLock::new(ClientState {
                timeout: Some(timeout),
                plan: ProxyPlan::Disabled,
                client,
                manual_redirect_client,
                custom_ca_certificates: Vec::new(),
                accept_invalid_certificates: false,
                system: None,
            }),
        }
    }

    /// Cliente atual (barato de clonar: compartilha o pool de conexões).
    ///
    /// No modo Sistema, se a configuração do sistema mudou desde a construção
    /// (ex.: proxy ligado no Windows), o cliente é reconstruído antes — baixando
    /// o script de configuração, se houver, e com pool novo, para não
    /// reaproveitar conexões abertas com o proxy anterior.
    pub async fn get(&self) -> Client {
        if let Some(stale) = self.stale_system() {
            let system = stale.load_script().await;
            // Só falha na inicialização do TLS; nesse caso segue com o atual.
            let _ = self.rebuild(|state| {
                if matches!(state.plan, ProxyPlan::System) {
                    state.system = Some(system);
                }
            });
        }
        match self.state.read() {
            Ok(guard) => guard.client.clone(),
            Err(poisoned) => poisoned.into_inner().client.clone(),
        }
    }

    /// Cliente com política de redirects por execução. Os dois clientes são
    /// reconstruídos juntos ao mudar proxy/timeout, para conservar as mesmas
    /// opções de rede e pools separados por política.
    pub async fn get_for_request(&self, policy: RedirectPolicy) -> RequestClient {
        let _ = self.get().await;
        let guard = match self.state.read() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let client = match policy {
            RedirectPolicy::Follow => guard.client.clone(),
            RedirectPolicy::Manual => guard.manual_redirect_client.clone(),
        };
        RequestClient {
            client,
            accepts_invalid_certificates: guard.accept_invalid_certificates,
        }
    }

    /// Configuração do sistema relida, quando a do cliente atual ficou
    /// desatualizada.
    fn stale_system(&self) -> Option<SystemState> {
        let guard = match self.state.read() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard
            .system
            .as_ref()
            .filter(|system| system.is_stale())
            .map(|system| SystemState::capture(Some(system)))
    }

    /// Passa a usar `plan` nas próximas requisições, mantendo o timeout.
    pub fn reconfigure(&self, plan: &ProxyPlan) -> Result<(), ProxyError> {
        self.rebuild(|state| {
            state.system = matches!(plan, ProxyPlan::System)
                .then(|| SystemState::capture(state.system.as_ref()));
            state.plan = plan.clone();
        })
    }

    /// Passa a usar `timeout` nas próximas requisições (`None` desabilita),
    /// mantendo o proxy. Chamadas em andamento seguem com o valor anterior.
    pub fn set_timeout(&self, timeout: Option<Duration>) -> Result<(), ProxyError> {
        self.rebuild(|state| state.timeout = timeout)
    }

    /// Acrescenta bundles PEM ao repositório de CAs do sistema. A validação
    /// normal da cadeia e do hostname permanece ativa.
    pub fn set_custom_ca_certificates(&self, pem_bundles: &[String]) -> Result<(), ProxyError> {
        let mut certificates = Vec::new();
        for bundle in pem_bundles {
            let parsed = reqwest::Certificate::from_pem_bundle(bundle.as_bytes())
                .map_err(|error| ProxyError::CustomCa(error.to_string()))?;
            if parsed.is_empty() {
                return Err(ProxyError::CustomCa(
                    "o arquivo não contém nenhuma CA PEM".into(),
                ));
            }
            certificates.extend(parsed);
        }
        self.rebuild(|state| state.custom_ca_certificates = certificates)
    }

    /// Liga ou desliga a verificação de certificado TLS (cadeia, prazo e
    /// hostname) nas próximas requisições. Desligada, qualquer certificado é
    /// aceito; só os executores de chamadas do usuário expõem esta opção.
    pub fn set_accept_invalid_certificates(&self, accept: bool) -> Result<(), ProxyError> {
        self.rebuild(|state| state.accept_invalid_certificates = accept)
    }

    /// Aplica `change` e reconstrói o cliente sob o mesmo lock, para que
    /// proxy e timeout trocados ao mesmo tempo não se sobrescrevam.
    fn rebuild(&self, change: impl FnOnce(&mut ClientState)) -> Result<(), ProxyError> {
        let mut guard = match self.state.write() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut next = ClientState {
            timeout: guard.timeout,
            plan: guard.plan.clone(),
            client: guard.client.clone(),
            manual_redirect_client: guard.manual_redirect_client.clone(),
            custom_ca_certificates: guard.custom_ca_certificates.clone(),
            accept_invalid_certificates: guard.accept_invalid_certificates,
            system: guard.system.clone(),
        };
        change(&mut next);
        next.client = build(
            next.timeout,
            &next.plan,
            next.system.as_ref(),
            RedirectPolicy::Follow,
            &next.custom_ca_certificates,
            next.accept_invalid_certificates,
        )?;
        next.manual_redirect_client = build(
            next.timeout,
            &next.plan,
            next.system.as_ref(),
            RedirectPolicy::Manual,
            &next.custom_ca_certificates,
            next.accept_invalid_certificates,
        )?;
        *guard = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const PAC_FOR: &str = r#"function FindProxyForURL(url, host) { return "PROXY __PROXY__"; }"#;

    #[tokio::test]
    async fn pac_download_failure_is_reported() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/proxy.pac"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let settings = ProxySettings::pac(format!("{}/proxy.pac", server.uri())).unwrap();
        let result = ProxyPlan::resolve(&settings).await;
        assert!(matches!(result, Err(ProxyError::PacDownload(_))));
    }

    #[tokio::test]
    async fn requests_go_through_the_proxy_chosen_by_the_pac() {
        // O "proxy" e o script PAC são o mesmo servidor de teste: um proxy
        // HTTP recebe a requisição com URL absoluta, o que o wiremock casa
        // por caminho.
        let server = MockServer::start().await;
        let proxy_address = server.address().to_string();
        Mock::given(method("GET"))
            .and(path("/proxy.pac"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(PAC_FOR.replace("__PROXY__", &proxy_address)),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/via-proxy"))
            .respond_with(ResponseTemplate::new(200).set_body_string("proxied"))
            .mount(&server)
            .await;

        let settings = ProxySettings::pac(format!("{}/proxy.pac", server.uri())).unwrap();
        let plan = ProxyPlan::resolve(&settings).await.unwrap();
        let shared = SharedHttpClient::new(Duration::from_secs(5));
        shared.reconfigure(&plan).unwrap();

        let body = shared
            .get()
            .await
            .get("http://destino.invalido.test/via-proxy")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body, "proxied");

        // Desativando o proxy, o destino inexistente deixa de ser alcançado.
        shared.reconfigure(&ProxyPlan::Disabled).unwrap();
        assert!(
            shared
                .get()
                .await
                .get("http://destino.invalido.test/via-proxy")
                .send()
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn the_timeout_can_be_changed_and_disabled_at_runtime() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/slow"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(300)))
            .mount(&server)
            .await;
        let url = format!("{}/slow", server.uri());
        let shared = SharedHttpClient::new(Duration::from_secs(5));

        shared.set_timeout(Some(Duration::from_millis(50))).unwrap();
        let error = shared.get().await.get(&url).send().await.unwrap_err();
        assert!(error.is_timeout());

        shared.set_timeout(None).unwrap();
        let response = shared.get().await.get(&url).send().await.unwrap();
        assert_eq!(response.status(), 200);
    }

    #[tokio::test]
    async fn certificate_verification_is_on_by_default_and_survives_other_changes() {
        let shared = SharedHttpClient::new(Duration::from_secs(5));
        assert!(
            !shared
                .get_for_request(RedirectPolicy::Follow)
                .await
                .accepts_invalid_certificates
        );

        shared.set_accept_invalid_certificates(true).unwrap();
        shared.set_timeout(None).unwrap();
        shared.reconfigure(&ProxyPlan::Disabled).unwrap();
        shared.set_custom_ca_certificates(&[]).unwrap();
        for policy in [RedirectPolicy::Follow, RedirectPolicy::Manual] {
            assert!(
                shared
                    .get_for_request(policy)
                    .await
                    .accepts_invalid_certificates
            );
        }

        shared.set_accept_invalid_certificates(false).unwrap();
        assert!(
            !shared
                .get_for_request(RedirectPolicy::Manual)
                .await
                .accepts_invalid_certificates
        );
    }

    #[tokio::test]
    async fn changing_the_proxy_keeps_the_timeout() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/slow"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(300)))
            .mount(&server)
            .await;
        let shared = SharedHttpClient::new(Duration::from_secs(5));
        shared.set_timeout(Some(Duration::from_millis(50))).unwrap();

        shared.reconfigure(&ProxyPlan::Disabled).unwrap();
        let error = shared
            .get()
            .await
            .get(format!("{}/slow", server.uri()))
            .send()
            .await
            .unwrap_err();
        assert!(error.is_timeout());
    }
}
