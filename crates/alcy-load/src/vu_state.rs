//! Estado isolado e efêmero de um VU do runner independente.

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use alcy_domain::{HeaderEntry, Request, Response};
use url::Url;

/// Estado que permanece entre iterações de um mesmo VU. Nunca é enviado por
/// IPC, persistido no histórico ou compartilhado entre VUs.
#[derive(Debug)]
pub struct LoadVuState {
    variables: BTreeMap<String, String>,
    cookies: Vec<StoredCookie>,
    headers: Vec<HeaderEntry>,
    cookies_enabled: bool,
    rng_state: u64,
    dataset_row: u64,
    once: BTreeSet<String>,
    iteration: u64,
    iteration_started_at: Option<Instant>,
    dataset_rows: BTreeMap<String, u64>,
}

#[derive(Debug, Clone)]
struct StoredCookie {
    name: String,
    value: String,
    domain: String,
    host_only: bool,
    path: String,
    secure: bool,
    expires_at: Option<SystemTime>,
}

impl LoadVuState {
    pub fn new(seed: u64) -> Self {
        Self {
            variables: BTreeMap::new(),
            cookies: Vec::new(),
            headers: Vec::new(),
            cookies_enabled: true,
            // Xorshift não pode iniciar em zero.
            rng_state: seed.max(1),
            dataset_row: 0,
            once: BTreeSet::new(),
            iteration: 0,
            iteration_started_at: None,
            dataset_rows: BTreeMap::new(),
        }
    }

    pub fn variables(&self) -> &BTreeMap<String, String> {
        &self.variables
    }

    pub fn variables_mut(&mut self) -> &mut BTreeMap<String, String> {
        &mut self.variables
    }

    pub(crate) fn enter_once(&mut self, id: &str) -> bool {
        self.once.insert(id.to_string())
    }

    pub(crate) fn begin_iteration(&mut self, vu_id: usize) -> u64 {
        self.iteration_started_at = Some(Instant::now());
        self.variables
            .insert("__VU".into(), (vu_id + 1).to_string());
        let iteration = self.iteration;
        self.variables
            .insert("__ITER".into(), iteration.to_string());
        self.iteration = self.iteration.saturating_add(1);
        iteration
    }

    pub(crate) fn iteration_elapsed(&self) -> Duration {
        self.iteration_started_at
            .map_or(Duration::ZERO, |started| started.elapsed())
    }

    pub(crate) fn dataset_row_for(&mut self, id: &str) -> u64 {
        let cursor = self.dataset_rows.entry(id.into()).or_default();
        let row = *cursor;
        *cursor = cursor.saturating_add(1);
        row
    }

    /// Fonte pseudoaleatória determinística, exclusiva do VU.
    pub fn next_random(&mut self) -> u64 {
        let mut value = self.rng_state;
        value ^= value << 13;
        value ^= value >> 7;
        value ^= value << 17;
        self.rng_state = value;
        value
    }

    /// Próximo índice de dataset para este VU. A associação concreta a CSV ou
    /// JSON será feita pelo bloco `Dataset`, sem trocar o contrato do worker.
    pub fn next_dataset_row(&mut self) -> u64 {
        let row = self.dataset_row;
        self.dataset_row = self.dataset_row.saturating_add(1);
        row
    }

    pub fn configure_headers(&mut self, headers: &[HeaderEntry]) {
        for header in headers {
            self.headers
                .retain(|current| !current.name().eq_ignore_ascii_case(header.name()));
            self.headers.push(header.clone());
        }
    }

    pub fn set_cookies_enabled(&mut self, enabled: bool) {
        self.cookies_enabled = enabled;
    }

    pub fn apply_defaults(&mut self, request: &mut Request) {
        for header in &self.headers {
            let overridden = request
                .headers
                .iter()
                .any(|current| current.name().eq_ignore_ascii_case(header.name()));
            if !overridden {
                request.headers.push(header.clone());
            }
        }
    }

    pub fn apply_cookies(&mut self, request: &mut Request) {
        if !self.cookies_enabled {
            return;
        }
        if request
            .headers
            .iter()
            .any(|header| header.enabled && header.name().eq_ignore_ascii_case("cookie"))
        {
            return;
        }
        let Some(value) = self.cookie_header(request.endpoint.url()) else {
            return;
        };
        if let Ok(header) = HeaderEntry::new("Cookie", value, true) {
            request.headers.push(header);
        }
    }

    pub fn remember_cookies(&mut self, requested_url: &str, response: &Response) {
        if !self.cookies_enabled {
            return;
        }
        let url = response.final_url.as_deref().unwrap_or(requested_url);
        let Ok(url) = Url::parse(url) else {
            return;
        };
        let Some(host) = url.host_str().map(str::to_ascii_lowercase) else {
            return;
        };
        let now = SystemTime::now();
        self.cookies
            .retain(|cookie| !matches!(cookie.expires_at, Some(at) if at <= now));
        for cookie in &response.cookies {
            let (domain, host_only) = match cookie
                .domain
                .as_deref()
                .map(|domain| domain.trim_start_matches('.').to_ascii_lowercase())
                .filter(|domain| !domain.is_empty())
            {
                Some(domain) if domain_matches(&host, &domain) => (domain, false),
                Some(_) => continue,
                None => (host.clone(), true),
            };
            let path = cookie
                .path
                .clone()
                .filter(|path| path.starts_with('/'))
                .unwrap_or_else(|| default_path(url.path()));
            let expires_at = match cookie.max_age_seconds {
                Some(seconds) if seconds <= 0 => Some(UNIX_EPOCH),
                Some(seconds) => Some(now + Duration::from_secs(seconds as u64)),
                None => None,
            };
            self.cookies.retain(|existing| {
                !(existing.name == cookie.name
                    && existing.domain == domain
                    && existing.path == path)
            });
            if expires_at.is_some_and(|at| at <= now) {
                continue;
            }
            self.cookies.push(StoredCookie {
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

    fn cookie_header(&mut self, request_url: &str) -> Option<String> {
        let url = Url::parse(request_url).ok()?;
        let host = url.host_str()?.to_ascii_lowercase();
        let secure = url.scheme() == "https";
        let path = url.path();
        let now = SystemTime::now();
        self.cookies
            .retain(|cookie| !matches!(cookie.expires_at, Some(at) if at <= now));
        let mut matching: Vec<&StoredCookie> = self
            .cookies
            .iter()
            .filter(|cookie| {
                let domain_matches = if cookie.host_only {
                    cookie.domain == host
                } else {
                    domain_matches(&host, &cookie.domain)
                };
                domain_matches && path_matches(path, &cookie.path) && (secure || !cookie.secure)
            })
            .collect();
        matching.sort_by_key(|cookie| std::cmp::Reverse(cookie.path.len()));
        (!matching.is_empty()).then(|| {
            matching
                .iter()
                .map(|cookie| format!("{}={}", cookie.name, cookie.value))
                .collect::<Vec<_>>()
                .join("; ")
        })
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

fn default_path(request_path: &str) -> String {
    match request_path.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(index) => request_path[..index].to_string(),
    }
}

#[cfg(test)]
mod tests {
    use alcy_domain::Cookie;

    use super::*;

    fn cookie(name: &str, value: &str) -> Cookie {
        Cookie {
            name: name.to_string(),
            value: value.to_string(),
            ..Cookie::default()
        }
    }

    #[test]
    fn keeps_cookies_inside_one_vu() {
        let mut first = LoadVuState::new(1);
        let mut second = LoadVuState::new(2);
        let response = Response::new(
            200,
            1,
            "",
            Vec::new(),
            alcy_domain::ResponseMetadata {
                cookies: vec![cookie("sid", "first")],
                ..alcy_domain::ResponseMetadata::default()
            },
        );
        first.remember_cookies("https://api.example.test/login", &response);

        let mut first_request = Request::new(
            alcy_domain::Endpoint::new("https://api.example.test/me").unwrap(),
            alcy_domain::RequestDocument::new(alcy_domain::ProtocolId::Rest, ""),
            "",
            Vec::new(),
            alcy_domain::Authentication::None,
        );
        let mut second_request = first_request.clone();
        first.apply_cookies(&mut first_request);
        second.apply_cookies(&mut second_request);

        assert_eq!(first_request.headers[0].value(), "sid=first");
        assert!(second_request.headers.is_empty());
    }
}
