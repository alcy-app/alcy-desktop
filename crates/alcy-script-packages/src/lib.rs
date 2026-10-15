//! npm packages for scripts (spec 0128, ADR 0061): downloads the packages a
//! script requires from esm.sh, before it runs, and caches them on disk.
//!
//! esm.sh serves a package as an ES module bundle: the entry
//! (`/<name>?bundle&target=es2022`) re-exports the bundle named in its
//! `x-esm-path` header, and bundles of packages that use Node APIs import
//! esm.sh's polyfills by absolute path. A package is the bundle plus every
//! module it imports, transitively, from the same host.

use std::collections::{BTreeMap, VecDeque};
use std::fmt::Write as _;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

use alcy_scripting::{ScriptPackages, resolve_specifier};
use serde::{Deserialize, Serialize};
use thiserror::Error;

const ESM_SH_HOST: &str = "esm.sh";
const TARGET: &str = "es2022";
const MAX_MODULES: usize = 128;
const MAX_PACKAGE_BYTES: usize = 16 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REDIRECTS: usize = 5;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PackageError {
    #[error("nome de pacote npm inválido: {0}")]
    InvalidName(String),
    #[error("falha ao baixar o pacote {package}: {message}")]
    Download { package: String, message: String },
    #[error("o pacote {package} excede o limite de {limit}")]
    TooLarge { package: String, limit: String },
    #[error("falha na cache de pacotes npm: {0}")]
    Cache(String),
}

/// A module as served by esm.sh.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fetched {
    pub body: String,
    /// `x-esm-path` header: the bundle an entry re-exports.
    pub esm_path: Option<String>,
}

/// Downloaded packages, one JSON file per package name in `dir`.
#[derive(Debug, Clone)]
pub struct PackageCache {
    dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedPackage {
    entry: String,
    modules: BTreeMap<String, String>,
}

impl PackageCache {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn file(&self, name: &str) -> PathBuf {
        // Hex keeps any package name (`@scope/pkg@1.0.0`) a plain file name.
        let mut file = String::with_capacity(name.len() * 2 + 5);
        for byte in name.bytes() {
            let _ = write!(file, "{byte:02x}");
        }
        file.push_str(".json");
        self.dir.join(file)
    }

    /// A cached package; a missing or unreadable file is a cache miss.
    fn load(&self, name: &str) -> Option<CachedPackage> {
        let text = std::fs::read_to_string(self.file(name)).ok()?;
        let package: CachedPackage = serde_json::from_str(&text).ok()?;
        package
            .modules
            .contains_key(&package.entry)
            .then_some(package)
    }

    fn store(&self, name: &str, package: &CachedPackage) -> Result<(), PackageError> {
        let cache_error = |error: std::io::Error| PackageError::Cache(error.to_string());
        std::fs::create_dir_all(&self.dir).map_err(cache_error)?;
        let json = serde_json::to_string(package)
            .map_err(|error| PackageError::Cache(error.to_string()))?;
        let file = self.file(name);
        // Written aside and renamed, so a concurrent reader never sees half a file.
        let partial = file.with_extension("json.partial");
        std::fs::write(&partial, json).map_err(cache_error)?;
        std::fs::rename(&partial, &file).map_err(cache_error)
    }
}

/// npm packages for a script: from the cache, or downloaded with `fetch`
/// (an esm.sh path and query → the module) and then cached.
pub async fn resolve_packages<F, Fut>(
    names: &[String],
    cache: &PackageCache,
    fetch: F,
) -> Result<ScriptPackages, PackageError>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<Fetched, String>>,
{
    let mut packages = ScriptPackages::default();
    for name in names {
        validate_name(name)?;
        let package = match cache.load(name) {
            Some(package) => package,
            None => {
                let package = download(name, &fetch).await?;
                cache.store(name, &package)?;
                package
            }
        };
        packages.entries.insert(name.clone(), package.entry);
        packages.modules.extend(package.modules);
    }
    Ok(packages)
}

/// Package names as npm allows them (`name`, `@scope/name`, an optional
/// `@version`, and a subpath such as `lodash@4/fp`), never a path that could
/// leave esm.sh's package space.
fn validate_name(name: &str) -> Result<(), PackageError> {
    let valid = !name.is_empty()
        && name.len() <= 214
        && !name.starts_with('/')
        && !name
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        && name.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '@' | '/' | '.' | '_' | '-' | '~' | '^')
        });
    if valid {
        Ok(())
    } else {
        Err(PackageError::InvalidName(name.to_string()))
    }
}

async fn download<F, Fut>(name: &str, fetch: &F) -> Result<CachedPackage, PackageError>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<Fetched, String>>,
{
    let failed = |message: String| PackageError::Download {
        package: name.to_string(),
        message,
    };
    let too_large = |limit: String| PackageError::TooLarge {
        package: name.to_string(),
        limit,
    };

    let stub = fetch(format!("/{name}?bundle&target={TARGET}"))
        .await
        .map_err(failed)?;
    let mut modules = BTreeMap::new();
    let mut queue = VecDeque::new();
    let mut total = 0;
    let entry = match stub.esm_path.filter(|path| path.starts_with('/')) {
        Some(path) => {
            // The entry only re-exports the bundle: the bundle is the entry.
            let bundle = fetch(path.clone()).await.map_err(failed)?;
            total += bundle.body.len();
            queue.extend(imports_of(&path, &bundle.body));
            modules.insert(path.clone(), bundle.body);
            path
        }
        None => {
            let path = format!("/{name}");
            total += stub.body.len();
            queue.extend(imports_of(&path, &stub.body));
            modules.insert(path.clone(), stub.body);
            path
        }
    };

    while let Some(path) = queue.pop_front() {
        if modules.contains_key(&path) {
            continue;
        }
        if modules.len() >= MAX_MODULES {
            return Err(too_large(format!("{MAX_MODULES} módulos")));
        }
        // A failed import is skipped rather than fatal: the scan can mistake a
        // string for an import, and a module that is really needed fails at
        // evaluation with its path in the message.
        let Ok(module) = fetch(path.clone()).await else {
            continue;
        };
        total += module.body.len();
        if total > MAX_PACKAGE_BYTES {
            return Err(too_large(format!(
                "{} MiB",
                MAX_PACKAGE_BYTES / (1024 * 1024)
            )));
        }
        queue.extend(imports_of(&path, &module.body));
        modules.insert(path, module.body);
    }
    Ok(CachedPackage { entry, modules })
}

/// Paths of the esm.sh modules that `source` (at `path`) imports.
fn imports_of(path: &str, source: &str) -> Vec<String> {
    module_specifiers(source)
        .into_iter()
        .filter_map(|specifier| resolve_specifier(&specifier, Some(Path::new(path))))
        .collect()
}

/// Specifiers after `from` and `import` (`import "x"`, `import("x")`,
/// `export * from "x"`), minified or not. A lexical scan: a string that looks
/// like an import may be listed too.
pub fn module_specifiers(source: &str) -> Vec<String> {
    let mut specifiers = Vec::new();
    for keyword in ["from", "import"] {
        for (at, _) in source.match_indices(keyword) {
            let preceded_by_identifier = source[..at]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$' || c == '.');
            if preceded_by_identifier {
                continue;
            }
            let rest = source[at + keyword.len()..].trim_start();
            let rest = if keyword == "import" {
                rest.strip_prefix('(').unwrap_or(rest).trim_start()
            } else {
                rest
            };
            let Some(quote) = rest.chars().next().filter(|c| matches!(c, '"' | '\'')) else {
                continue;
            };
            if let Some(end) = rest[1..].find(quote) {
                let specifier = &rest[1..1 + end];
                if !specifier.is_empty() && !specifiers.iter().any(|known| known == specifier) {
                    specifiers.push(specifier.to_string());
                }
            }
        }
    }
    specifiers
}

/// HTTP client for esm.sh: timeouts, system proxy, and redirects only
/// within esm.sh.
pub fn esm_sh_client() -> Result<reqwest::Client, PackageError> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() < MAX_REDIRECTS
                && attempt.url().host_str() == Some(ESM_SH_HOST)
            {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|error| PackageError::Cache(error.to_string()))
}

/// Fetches an esm.sh path (with its query).
pub async fn fetch_from_esm_sh(client: &reqwest::Client, path: &str) -> Result<Fetched, String> {
    let response = client
        .get(format!("https://{ESM_SH_HOST}{path}"))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {status} em {path}"));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PACKAGE_BYTES as u64)
    {
        return Err(format!(
            "{path} excede {} MiB",
            MAX_PACKAGE_BYTES / (1024 * 1024)
        ));
    }
    let esm_path = response
        .headers()
        .get("x-esm-path")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let body = response.text().await.map_err(|error| error.to_string())?;
    Ok(Fetched { body, esm_path })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_cache() -> PackageCache {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "alcy-script-packages-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        PackageCache::new(dir)
    }

    /// A fake esm.sh: path → (body, x-esm-path).
    fn server(routes: &[(&str, &str, Option<&str>)]) -> HashMap<String, Fetched> {
        routes
            .iter()
            .map(|(path, body, esm_path)| {
                (
                    path.to_string(),
                    Fetched {
                        body: body.to_string(),
                        esm_path: esm_path.map(str::to_string),
                    },
                )
            })
            .collect()
    }

    fn names(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    #[tokio::test]
    async fn downloads_the_bundle_and_its_imports_then_uses_the_cache() {
        let routes = server(&[
            (
                "/greet@1.0.0?bundle&target=es2022",
                "export * from \"/greet@1.0.0/es2022/greet.bundle.mjs\";",
                Some("/greet@1.0.0/es2022/greet.bundle.mjs"),
            ),
            (
                "/greet@1.0.0/es2022/greet.bundle.mjs",
                "import{a}from\"/node/a.mjs\";import b from './b.mjs';import 'https://esm.sh/node/c.mjs';\
                 import lodash from 'lodash';export default a+b;",
                None,
            ),
            ("/node/a.mjs", "export const a = 1;", None),
            ("/greet@1.0.0/es2022/b.mjs", "export default 2;", None),
            ("/node/c.mjs", "", None),
        ]);
        let calls = Cell::new(0);
        let fetch = |path: String| {
            calls.set(calls.get() + 1);
            let found = routes.get(&path).cloned();
            async move { found.ok_or_else(|| format!("404 {path}")) }
        };
        let cache = temp_cache();

        let packages = resolve_packages(&names(&["greet@1.0.0"]), &cache, fetch)
            .await
            .unwrap();
        assert_eq!(
            packages.entries.get("greet@1.0.0").map(String::as_str),
            Some("/greet@1.0.0/es2022/greet.bundle.mjs")
        );
        assert_eq!(
            packages
                .modules
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec![
                "/greet@1.0.0/es2022/b.mjs",
                "/greet@1.0.0/es2022/greet.bundle.mjs",
                "/node/a.mjs",
                "/node/c.mjs",
            ]
        );
        assert_eq!(calls.get(), 5);

        let cached = resolve_packages(&names(&["greet@1.0.0"]), &cache, |path: String| {
            calls.set(calls.get() + 1);
            async move { Err::<Fetched, _>(format!("offline: {path}")) }
        })
        .await
        .unwrap();
        assert_eq!(cached, packages);
        assert_eq!(calls.get(), 5);
    }

    #[tokio::test]
    async fn an_entry_without_esm_path_is_the_module_itself() {
        let routes = server(&[("/tiny?bundle&target=es2022", "export default 1;", None)]);
        let fetch = |path: String| {
            let found = routes.get(&path).cloned();
            async move { found.ok_or_else(|| "404".to_string()) }
        };
        let packages = resolve_packages(&names(&["tiny"]), &temp_cache(), fetch)
            .await
            .unwrap();
        assert_eq!(
            packages.entries.get("tiny").map(String::as_str),
            Some("/tiny")
        );
        assert_eq!(
            packages.modules.get("/tiny").map(String::as_str),
            Some("export default 1;")
        );
    }

    #[tokio::test]
    async fn fails_when_the_package_cannot_be_downloaded() {
        let error = resolve_packages(
            &names(&["missing@1.0.0"]),
            &temp_cache(),
            |_path: String| async { Err::<Fetched, _>("HTTP 404".to_string()) },
        )
        .await
        .unwrap_err();
        assert_eq!(
            error,
            PackageError::Download {
                package: "missing@1.0.0".to_string(),
                message: "HTTP 404".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn limits_the_number_of_modules() {
        let fetch = |path: String| async move {
            let next = path
                .trim_start_matches("/m")
                .trim_end_matches(".mjs")
                .parse::<usize>()
                .unwrap_or(0)
                + 1;
            Ok(Fetched {
                body: format!("import \"/m{next}.mjs\";"),
                esm_path: (path.contains('?')).then(|| "/m0.mjs".to_string()),
            })
        };
        let error = resolve_packages(&names(&["chain"]), &temp_cache(), fetch)
            .await
            .unwrap_err();
        assert!(matches!(error, PackageError::TooLarge { .. }), "{error:?}");
    }

    #[tokio::test]
    async fn rejects_names_that_are_not_npm_package_names() {
        for name in [
            "../etc/passwd",
            "/abs",
            "a b",
            "pkg/../../x",
            "",
            "x?bundle",
        ] {
            let error = resolve_packages(&names(&[name]), &temp_cache(), |_path: String| async {
                Err::<Fetched, _>("unreachable".to_string())
            })
            .await
            .unwrap_err();
            assert_eq!(error, PackageError::InvalidName(name.to_string()));
        }
        for name in ["dayjs", "dayjs@1.11.13", "@scope/pkg@^2.0.0", "lodash@4/fp"] {
            assert_eq!(validate_name(name), Ok(()), "{name}");
        }
    }

    #[test]
    fn finds_module_specifiers_in_minified_and_regular_code() {
        let source = r#"import{a}from"/x.mjs";export*from'/y.mjs';import "./z.mjs";
            const lazy = import("/w.mjs"); const transform = x.from("/not.mjs"); import(dynamicName);"#;
        assert_eq!(
            module_specifiers(source),
            vec!["/x.mjs", "/y.mjs", "./z.mjs", "/w.mjs"]
        );
    }
}
