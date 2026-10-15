//! Where a call goes and how the connection is made: plaintext (h2c) or TLS,
//! directly or through an HTTP proxy tunnel.

use std::time::Duration;

use http::Uri;
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Endpoint};
use url::Url;

use crate::GrpcError;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Largest proxy reply to a `CONNECT` the tunnel reads before giving up.
const MAX_PROXY_REPLY_BYTES: usize = 16 * 1024;
/// Largest message the client accepts (tonic's default is 4 MiB).
pub(crate) const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

/// The server a request calls, from the address the person typed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrpcTarget {
    pub uri: Uri,
    pub tls: bool,
}

impl GrpcTarget {
    /// Accepts `host:port`, `grpc://` or `http://` (plaintext) and `grpcs://`
    /// or `https://` (TLS). Without a scheme, port 443 means TLS. A missing
    /// port defaults to 443 with TLS and 80 without.
    pub fn parse(endpoint: &str) -> Result<Self, GrpcError> {
        let endpoint = endpoint.trim();
        let invalid = |detail: &str| GrpcError::InvalidTarget(format!("{endpoint}: {detail}"));
        let (tls, rest) = match endpoint.split_once("://") {
            Some((scheme, rest)) => match scheme.to_ascii_lowercase().as_str() {
                "grpc" | "http" => (Some(false), rest),
                "grpcs" | "https" => (Some(true), rest),
                _ => return Err(invalid("use grpc://, grpcs:// ou host:porta")),
            },
            None => (None, endpoint),
        };
        let authority = rest.trim_end_matches('/');
        if authority.is_empty()
            || authority.contains('/')
            || authority.contains(char::is_whitespace)
        {
            return Err(invalid("informe só host e porta, sem caminho"));
        }
        let parsed: http::uri::Authority = authority
            .parse()
            .map_err(|_| invalid("host ou porta inválidos"))?;
        let tls = tls.unwrap_or(parsed.port_u16() == Some(443));
        let port = parsed.port_u16().unwrap_or(if tls { 443 } else { 80 });
        let scheme = if tls { "https" } else { "http" };
        let uri = format!("{scheme}://{}:{port}", parsed.host())
            .parse()
            .map_err(|_| invalid("host ou porta inválidos"))?;
        Ok(Self { uri, tls })
    }
}

/// Connection options shared with the HTTP executors' settings.
#[derive(Debug, Clone, Default)]
pub struct ConnectionSettings {
    /// Extra trusted roots (PEM bundles), on top of the system's.
    pub custom_ca_pems: Vec<String>,
    /// HTTP proxy to tunnel through (`CONNECT`); `None` connects directly.
    pub proxy: Option<Url>,
}

/// Opens a channel to `target`. Certificates are always verified (against
/// the system roots plus `custom_ca_pems`).
pub async fn connect(
    target: &GrpcTarget,
    settings: &ConnectionSettings,
) -> Result<Channel, GrpcError> {
    let mut endpoint = Endpoint::from(target.uri.clone()).connect_timeout(CONNECT_TIMEOUT);
    if target.tls {
        let mut tls = ClientTlsConfig::new().with_native_roots();
        for pem in &settings.custom_ca_pems {
            tls = tls.ca_certificate(Certificate::from_pem(pem));
        }
        endpoint = endpoint
            .tls_config(tls)
            .map_err(|error| GrpcError::Certificate(describe(&error)))?;
    }
    let proxy = settings.proxy.clone();
    let connector = tower::service_fn(move |uri: Uri| {
        let proxy = proxy.clone();
        async move {
            let host = uri
                .host()
                .ok_or_else(|| std::io::Error::other("endereço sem host"))?
                .trim_start_matches('[')
                .trim_end_matches(']')
                .to_string();
            let port = uri
                .port_u16()
                .unwrap_or(if uri.scheme_str() == Some("https") {
                    443
                } else {
                    80
                });
            let stream = match proxy {
                Some(proxy) => tunnel(&proxy, &host, port).await?,
                None => TcpStream::connect((host.as_str(), port)).await?,
            };
            stream.set_nodelay(true)?;
            Ok::<_, std::io::Error>(TokioIo::new(stream))
        }
    });
    endpoint
        .connect_with_connector(connector)
        .await
        .map_err(|error| GrpcError::Connection(describe(&error)))
}

/// Opens a TCP tunnel to `host:port` through an HTTP proxy (`CONNECT`).
async fn tunnel(proxy: &Url, host: &str, port: u16) -> std::io::Result<TcpStream> {
    if proxy.scheme() != "http" {
        return Err(std::io::Error::other(format!(
            "proxy {} não suportado para gRPC: use um proxy http://",
            proxy.scheme()
        )));
    }
    let proxy_host = proxy
        .host_str()
        .ok_or_else(|| std::io::Error::other("proxy sem host"))?;
    let proxy_port = proxy.port_or_known_default().unwrap_or(80);
    let mut stream = TcpStream::connect((proxy_host, proxy_port)).await?;

    let target = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let mut request = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if !proxy.username().is_empty() {
        let credentials = format!(
            "{}:{}",
            percent_decode(proxy.username()),
            percent_decode(proxy.password().unwrap_or_default())
        );
        request.push_str(&format!(
            "Proxy-Authorization: Basic {}\r\n",
            crate::base64::encode(credentials.as_bytes())
        ));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).await?;

    let mut reply = Vec::new();
    let mut byte = [0u8; 1];
    // Byte by byte: anything after the reply's blank line already belongs
    // to the tunnel.
    while !reply.ends_with(b"\r\n\r\n") {
        if reply.len() >= MAX_PROXY_REPLY_BYTES || stream.read(&mut byte).await? == 0 {
            return Err(std::io::Error::other(
                "o proxy encerrou a conexão sem responder ao CONNECT",
            ));
        }
        reply.push(byte[0]);
    }
    let status_line = String::from_utf8_lossy(&reply);
    let status_line = status_line.lines().next().unwrap_or_default();
    let accepted = status_line
        .split_whitespace()
        .nth(1)
        .is_some_and(|code| code.starts_with('2'));
    if accepted {
        Ok(stream)
    } else {
        Err(std::io::Error::other(format!(
            "o proxy recusou o túnel: {status_line}"
        )))
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |at: usize| bytes.get(at).and_then(|b| (*b as char).to_digit(16));
        match (bytes[i], hex(i + 1), hex(i + 2)) {
            (b'%', Some(high), Some(low)) => {
                decoded.push((high * 16 + low) as u8);
                i += 3;
            }
            (byte, _, _) => {
                decoded.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// The error with its causes: tonic's top-level message alone is often just
/// "transport error".
pub(crate) fn describe(error: &dyn std::error::Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if !message.contains(&text) {
            message.push_str(": ");
            message.push_str(&text);
        }
        source = cause.source();
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(endpoint: &str) -> (String, bool) {
        let target = GrpcTarget::parse(endpoint).unwrap();
        (target.uri.to_string(), target.tls)
    }

    #[test]
    fn parses_addresses_with_and_without_scheme() {
        assert_eq!(
            target("localhost:50051"),
            ("http://localhost:50051/".to_string(), false)
        );
        assert_eq!(
            target("api.example.com:443"),
            ("https://api.example.com:443/".to_string(), true)
        );
        assert_eq!(
            target("grpcs://api.example.com"),
            ("https://api.example.com:443/".to_string(), true)
        );
        assert_eq!(
            target("grpc://10.0.0.1:9000/"),
            ("http://10.0.0.1:9000/".to_string(), false)
        );
        assert_eq!(
            target("https://[::1]:8443"),
            ("https://[::1]:8443/".to_string(), true)
        );
        for invalid in ["", "ftp://host:1", "host:1/path", "host :1"] {
            assert!(GrpcTarget::parse(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn decodes_percent_encoded_proxy_credentials() {
        assert_eq!(percent_decode("pa%20ss%zz"), "pa ss%zz");
    }
}
