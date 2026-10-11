//! Cookie jar: guarda os `Set-Cookie` recebidos e devolve o header
//! `Cookie` das requisições seguintes. Usado por run do runner de coleções
//! (spec 0073) e, na sessão do app, pelas requisições avulsas (spec 0108).
//! Vive só em memória.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alcy_domain::{Cookie, HeaderEntry, Request, Response};
use serde::Serialize;
use url::Url;

/// Cookie guardado, como a UI lista.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredCookieOutput {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub host_only: bool,
    pub path: String,
    pub secure: bool,
    /// `None` = cookie de sessão (vale até o app fechar).
    pub expires_at_ms: Option<u64>,
}

#[derive(Debug, Clone)]
struct StoredCookie {
    name: String,
    value: String,
    /// Em minúsculas, sem ponto inicial.
    domain: String,
    /// Sem atributo `Domain`: só o host exato recebe o cookie.
    host_only: bool,
    path: String,
    secure: bool,
    expires_at: Option<SystemTime>,
}

#[derive(Default)]
pub(crate) struct CookieJar {
    cookies: Mutex<Vec<StoredCookie>>,
}

impl CookieJar {
    /// Guarda os cookies recebidos numa resposta de `url`. Um cookie já
    /// expirado (ex.: `Max-Age=0` num logout) remove o existente.
    pub(crate) fn store(&self, url: &str, received: &[Cookie]) {
        self.store_at(url, received, SystemTime::now());
    }

    /// Valor do header `Cookie` para `url`, ou `None` sem cookie aplicável.
    pub(crate) fn header_for(&self, url: &str) -> Option<String> {
        self.header_at(url, SystemTime::now())
    }

    /// Acrescenta o header `Cookie` a `request`, a menos que o usuário já
    /// tenha definido um (o dele prevalece).
    pub(crate) fn apply_to(&self, request: &mut Request) {
        let has_cookie_header = request
            .headers
            .iter()
            .any(|header| header.enabled && header.name().eq_ignore_ascii_case("cookie"));
        if has_cookie_header {
            return;
        }
        if let Some(value) = self.header_for(request.endpoint.url()) {
            if let Ok(header) = HeaderEntry::new("Cookie", &value, true) {
                request.headers.push(header);
            }
        }
    }

    /// Guarda os cookies de `response`, atribuídos à URL final (após
    /// redirects) ou, sem ela, à URL pedida.
    pub(crate) fn remember(&self, requested_url: &str, response: &Response) {
        let url = response.final_url.as_deref().unwrap_or(requested_url);
        self.store(url, &response.cookies);
    }

    /// Cookies ainda válidos, ordenados por domínio, path e nome.
    pub(crate) fn list(&self) -> Vec<StoredCookieOutput> {
        let now = SystemTime::now();
        let mut cookies = self.lock();
        cookies.retain(|cookie| !matches!(cookie.expires_at, Some(at) if at <= now));
        let mut listed: Vec<StoredCookieOutput> = cookies
            .iter()
            .map(|cookie| StoredCookieOutput {
                name: cookie.name.clone(),
                value: cookie.value.clone(),
                domain: cookie.domain.clone(),
                host_only: cookie.host_only,
                path: cookie.path.clone(),
                secure: cookie.secure,
                expires_at_ms: cookie.expires_at.and_then(|at| {
                    at.duration_since(UNIX_EPOCH)
                        .ok()
                        .map(|elapsed| elapsed.as_millis() as u64)
                }),
            })
            .collect();
        listed.sort_by(|a, b| (&a.domain, &a.path, &a.name).cmp(&(&b.domain, &b.path, &b.name)));
        listed
    }

    /// Remove o cookie identificado por domínio, path e nome.
    pub(crate) fn remove(&self, domain: &str, path: &str, name: &str) {
        self.lock().retain(|cookie| {
            !(cookie.domain == domain && cookie.path == path && cookie.name == name)
        });
    }

    pub(crate) fn clear(&self) {
        self.lock().clear();
    }

    fn store_at(&self, url: &str, received: &[Cookie], now: SystemTime) {
        let Ok(url) = Url::parse(url) else {
            return;
        };
        let Some(host) = url.host_str().map(str::to_ascii_lowercase) else {
            return;
        };
        let mut cookies = self.lock();
        for cookie in received {
            let (domain, host_only) = match cookie
                .domain
                .as_deref()
                .map(|d| d.trim_start_matches('.').to_ascii_lowercase())
                .filter(|d| !d.is_empty())
            {
                // Um servidor não pode definir cookie para outro domínio.
                Some(domain) if domain_matches(&host, &domain) => (domain, false),
                Some(_) => continue,
                None => (host.clone(), true),
            };
            let path = cookie
                .path
                .clone()
                .filter(|p| p.starts_with('/'))
                .unwrap_or_else(|| default_path(url.path()));
            let expires_at = match cookie.max_age_seconds {
                Some(seconds) if seconds <= 0 => Some(UNIX_EPOCH),
                Some(seconds) => Some(now + Duration::from_secs(seconds as u64)),
                None => cookie.expires.as_deref().and_then(parse_expires),
            };

            cookies.retain(|existing| {
                !(existing.name == cookie.name
                    && existing.domain == domain
                    && existing.path == path)
            });
            if expires_at.is_some_and(|at| at <= now) {
                continue;
            }
            cookies.push(StoredCookie {
                name: cookie.name.clone(),
                value: cookie.value.clone(),
                domain,
                host_only,
                path,
                secure: cookie.secure,
                expires_at,
            });
        }
    }

    fn header_at(&self, url: &str, now: SystemTime) -> Option<String> {
        let url = Url::parse(url).ok()?;
        let host = url.host_str()?.to_ascii_lowercase();
        let secure = url.scheme() == "https";
        let path = url.path();

        let mut cookies = self.lock();
        cookies.retain(|cookie| !matches!(cookie.expires_at, Some(at) if at <= now));
        let mut matching: Vec<&StoredCookie> = cookies
            .iter()
            .filter(|cookie| {
                let domain_ok = if cookie.host_only {
                    cookie.domain == host
                } else {
                    domain_matches(&host, &cookie.domain)
                };
                domain_ok && path_matches(path, &cookie.path) && (secure || !cookie.secure)
            })
            .collect();
        if matching.is_empty() {
            return None;
        }
        // RFC 6265: paths mais específicos primeiro.
        matching.sort_by_key(|cookie| std::cmp::Reverse(cookie.path.len()));
        Some(
            matching
                .iter()
                .map(|cookie| format!("{}={}", cookie.name, cookie.value))
                .collect::<Vec<_>>()
                .join("; "),
        )
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<StoredCookie>> {
        self.cookies
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn domain_matches(host: &str, domain: &str) -> bool {
    host == domain || host.ends_with(&format!(".{domain}"))
}

fn path_matches(request_path: &str, cookie_path: &str) -> bool {
    request_path == cookie_path
        || (request_path.starts_with(cookie_path)
            && (cookie_path.ends_with('/') || request_path[cookie_path.len()..].starts_with('/')))
}

/// Path padrão (RFC 6265 §5.1.4): o diretório do path da requisição.
fn default_path(request_path: &str) -> String {
    match request_path.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(index) => request_path[..index].to_string(),
    }
}

/// `Expires` chega formatado pelo `Display` de `time::OffsetDateTime`
/// (ex.: `2015-10-21 7:28:00.0 +00:00:00`). Sem conseguir ler, o cookie fica
/// como de sessão (vale até o fim do run).
fn parse_expires(text: &str) -> Option<SystemTime> {
    let mut parts = text.split_whitespace();
    let date = parts.next()?;
    let time = parts.next()?;
    let offset = parts.next().unwrap_or("+00:00:00");

    let mut date = date.split('-');
    let year: i64 = date.next()?.parse().ok()?;
    let month: i64 = date.next()?.parse().ok()?;
    let day: i64 = date.next()?.parse().ok()?;
    let mut time = time.split(':');
    let hour: i64 = time.next()?.parse().ok()?;
    let minute: i64 = time.next()?.parse().ok()?;
    let second: f64 = time.next()?.parse().ok()?;
    let (sign, offset) = match offset.split_at(1) {
        ("-", rest) => (-1, rest),
        ("+", rest) => (1, rest),
        _ => (1, offset),
    };
    let mut offset = offset.split(':').map(|p| p.parse::<i64>().unwrap_or(0));
    let offset_seconds = sign
        * (offset.next().unwrap_or(0) * 3600
            + offset.next().unwrap_or(0) * 60
            + offset.next().unwrap_or(0));

    let seconds =
        days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second as i64
            - offset_seconds;
    if seconds <= 0 {
        return Some(UNIX_EPOCH);
    }
    Some(UNIX_EPOCH + Duration::from_secs(seconds as u64))
}

/// Dias desde 1970-01-01 (algoritmo de Howard Hinnant).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cookie(name: &str, value: &str) -> Cookie {
        Cookie {
            name: name.to_string(),
            value: value.to_string(),
            ..Cookie::default()
        }
    }

    #[test]
    fn host_only_cookies_go_back_to_the_same_host() {
        let jar = CookieJar::default();
        jar.store("https://api.test/login", &[cookie("sid", "1")]);

        assert_eq!(
            jar.header_for("https://api.test/users").as_deref(),
            Some("sid=1")
        );
        assert_eq!(jar.header_for("https://sub.api.test/users"), None);
        assert_eq!(jar.header_for("https://other.test/"), None);
    }

    #[test]
    fn domain_cookies_reach_subdomains_but_not_foreign_domains() {
        let jar = CookieJar::default();
        let mut shared = cookie("a", "1");
        shared.domain = Some(".api.test".to_string());
        let mut foreign = cookie("b", "2");
        foreign.domain = Some("evil.test".to_string());
        jar.store("https://auth.api.test/", &[shared, foreign]);

        assert_eq!(
            jar.header_for("https://x.api.test/").as_deref(),
            Some("a=1")
        );
        assert_eq!(jar.header_for("https://evil.test/"), None);
    }

    #[test]
    fn path_and_secure_are_respected() {
        let jar = CookieJar::default();
        let mut scoped = cookie("p", "1");
        scoped.path = Some("/admin".to_string());
        let mut secure = cookie("s", "2");
        secure.secure = true;
        jar.store("https://api.test/", &[scoped, secure]);

        assert_eq!(
            jar.header_for("https://api.test/admin/users").as_deref(),
            Some("p=1; s=2")
        );
        assert_eq!(
            jar.header_for("https://api.test/administrator").as_deref(),
            Some("s=2")
        );
        // Sem https, o cookie `Secure` não vai.
        assert_eq!(
            jar.header_for("http://api.test/admin").as_deref(),
            Some("p=1")
        );
    }

    #[test]
    fn default_path_is_the_request_directory() {
        let jar = CookieJar::default();
        jar.store("https://api.test/v1/login", &[cookie("t", "1")]);

        assert!(jar.header_for("https://api.test/v1/me").is_some());
        assert!(jar.header_for("https://api.test/v2/me").is_none());
    }

    #[test]
    fn a_new_value_replaces_and_max_age_zero_removes() {
        let jar = CookieJar::default();
        jar.store("https://api.test/", &[cookie("sid", "1")]);
        jar.store("https://api.test/", &[cookie("sid", "2")]);
        assert_eq!(
            jar.header_for("https://api.test/").as_deref(),
            Some("sid=2")
        );

        let mut logout = cookie("sid", "");
        logout.max_age_seconds = Some(0);
        jar.store("https://api.test/", &[logout]);
        assert_eq!(jar.header_for("https://api.test/"), None);
    }

    #[test]
    fn expires_in_the_past_removes_and_in_the_future_keeps() {
        let jar = CookieJar::default();
        let mut future = cookie("a", "1");
        future.expires = Some("2999-01-01 0:00:00.0 +00:00:00".to_string());
        let mut past = cookie("b", "2");
        past.expires = Some("1970-01-01 0:00:00.0 +00:00:00".to_string());
        jar.store("https://api.test/", &[future, past]);

        assert_eq!(jar.header_for("https://api.test/").as_deref(), Some("a=1"));
    }

    #[test]
    fn max_age_expires_over_time() {
        let jar = CookieJar::default();
        let mut short = cookie("a", "1");
        short.max_age_seconds = Some(10);
        let now = SystemTime::now();
        jar.store_at("https://api.test/", &[short], now);

        assert!(jar.header_at("https://api.test/", now).is_some());
        assert!(
            jar.header_at("https://api.test/", now + Duration::from_secs(11))
                .is_none()
        );
    }

    #[test]
    fn apply_to_keeps_the_users_cookie_header() {
        use alcy_domain::{Authentication, Endpoint, ProtocolId, RequestDocument};

        let jar = CookieJar::default();
        jar.store("https://api.test/", &[cookie("sid", "1")]);
        let build = |headers| {
            Request::new(
                Endpoint::new("https://api.test/me").unwrap(),
                RequestDocument::new(ProtocolId::Rest, ""),
                "",
                headers,
                Authentication::None,
            )
        };

        let mut request = build(vec![]);
        jar.apply_to(&mut request);
        assert_eq!(request.headers.len(), 1);
        assert_eq!(request.headers[0].value(), "sid=1");

        let mut request = build(vec![HeaderEntry::new("cookie", "mine=1", true).unwrap()]);
        jar.apply_to(&mut request);
        assert_eq!(request.headers.len(), 1);
        assert_eq!(request.headers[0].value(), "mine=1");
    }

    #[test]
    fn lists_removes_and_clears() {
        let jar = CookieJar::default();
        jar.store("https://b.test/", &[cookie("x", "1")]);
        jar.store("https://a.test/", &[cookie("y", "2"), cookie("z", "3")]);

        let listed = jar.list();
        let names: Vec<_> = listed.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["y", "z", "x"]);
        assert!(listed[0].host_only);
        assert_eq!(listed[0].expires_at_ms, None);

        jar.remove("a.test", "/", "y");
        assert_eq!(jar.list().len(), 2);
        jar.clear();
        assert!(jar.list().is_empty());
    }

    #[test]
    fn parses_the_expires_format() {
        assert_eq!(
            parse_expires("2015-10-21 7:28:00.0 +00:00:00"),
            Some(UNIX_EPOCH + Duration::from_secs(1_445_412_480))
        );
        assert_eq!(
            parse_expires("2015-10-21 9:28:00.0 +02:00:00"),
            Some(UNIX_EPOCH + Duration::from_secs(1_445_412_480))
        );
        assert_eq!(parse_expires("amanhã"), None);
    }
}
