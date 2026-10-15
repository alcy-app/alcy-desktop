//! `require` support (spec 0128, ADR 0061): libraries bundled with the app
//! and npm packages downloaded by the host before the script runs. Nothing
//! here performs I/O; npm modules arrive as sources in [`ScriptPackages`].

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use boa_engine::builtins::promise::PromiseState;
use boa_engine::module::{ModuleLoader, Referrer};
use boa_engine::object::builtins::JsArray;
use boa_engine::{
    Context, JsNativeError, JsResult, JsString, JsValue, Module, NativeFunction, Source, js_string,
};

/// Prefix of npm package names in `require` (`require('npm:dayjs@1.11.13')`).
pub const NPM_PREFIX: &str = "npm:";

/// Largest `crypto.getRandomValues` request, as in the Web Crypto API.
const MAX_RANDOM_BYTES: usize = 65_536;

/// Libraries bundled with the app (UMD builds, MIT), by `require` name.
fn bundled_source(name: &str) -> Option<&'static str> {
    match name {
        "lodash" => Some(include_str!("../vendor/lodash/lodash.min.js")),
        "crypto-js" => Some(include_str!("../vendor/crypto-js/crypto-js.js")),
        "moment" => Some(include_str!("../vendor/moment/moment.min.js")),
        "uuid" => Some(include_str!("../vendor/uuid/uuid.min.js")),
        _ => None,
    }
}

/// npm packages available to a script, downloaded by the host.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScriptPackages {
    /// Package (`dayjs@1.11.13`, without the `npm:` prefix) → path of its
    /// entry module in `modules`.
    pub entries: BTreeMap<String, String>,
    /// Module path (e.g. `/dayjs@1.11.13/es2022/dayjs.bundle.mjs`) → source.
    pub modules: BTreeMap<String, String>,
}

/// npm packages a script requires with a literal name, without the `npm:`
/// prefix and without repetitions, in order of appearance. Covers
/// `require(…)`, `al.require(…)` and `pm.require(…)`; a computed name cannot
/// be downloaded ahead of time and is not listed.
pub fn npm_requests(source: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for (at, _) in source.match_indices("require(") {
        let rest = source[at + "require(".len()..].trim_start();
        let Some(quote) = rest
            .chars()
            .next()
            .filter(|c| matches!(c, '\'' | '"' | '`'))
        else {
            continue;
        };
        let Some(end) = rest[1..].find(quote) else {
            continue;
        };
        let Some(name) = rest[1..1 + end].strip_prefix(NPM_PREFIX) else {
            continue;
        };
        let name = name.trim();
        if !name.is_empty() && !name.contains('$') && !found.iter().any(|known| known == name) {
            found.push(name.to_string());
        }
    }
    found
}

/// Serves npm modules from memory to Boa's module system. A path always
/// yields the same `Module`, as the module loading algorithm requires.
pub(crate) struct PackageLoader {
    packages: Arc<ScriptPackages>,
    loaded: RefCell<HashMap<String, Module>>,
}

impl PackageLoader {
    pub(crate) fn new(packages: Arc<ScriptPackages>) -> Self {
        Self {
            packages,
            loaded: RefCell::new(HashMap::new()),
        }
    }

    fn module(&self, path: &str, context: &mut Context) -> JsResult<Module> {
        if let Some(module) = self.loaded.borrow().get(path) {
            return Ok(module.clone());
        }
        let source = self.packages.modules.get(path).ok_or_else(|| {
            JsNativeError::typ().with_message(format!("módulo não baixado: {path}"))
        })?;
        let module = Module::parse(
            Source::from_bytes(source).with_path(Path::new(path)),
            None,
            context,
        )?;
        self.loaded
            .borrow_mut()
            .insert(path.to_string(), module.clone());
        Ok(module)
    }
}

impl ModuleLoader for PackageLoader {
    async fn load_imported_module(
        self: Rc<Self>,
        referrer: Referrer,
        request: boa_engine::module::ModuleRequest,
        context: &RefCell<&mut Context>,
    ) -> JsResult<Module> {
        let specifier = request.specifier().to_std_string_escaped();
        let path = resolve_specifier(&specifier, referrer.path()).ok_or_else(|| {
            JsNativeError::typ().with_message(format!("importação não suportada: {specifier}"))
        })?;
        self.module(&path, &mut context.borrow_mut())
    }
}

/// Path of an esm.sh module imported as `specifier` by the module at
/// `referrer`: absolute paths and esm.sh URLs as they are, relative ones
/// against the referrer's folder. Bare names are not resolved.
pub fn resolve_specifier(specifier: &str, referrer: Option<&Path>) -> Option<String> {
    let specifier = specifier
        .strip_prefix("https://esm.sh")
        .unwrap_or(specifier);
    let joined = if specifier.starts_with('/') {
        PathBuf::from(specifier)
    } else if specifier.starts_with("./") || specifier.starts_with("../") {
        referrer?.parent()?.join(specifier)
    } else {
        return None;
    };
    let mut normalized = PathBuf::from("/");
    for component in joined.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::ParentDir => {
                normalized.pop();
            }
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    Some(normalized.to_string_lossy().replace('\\', "/"))
}

thread_local! {
    /// The running script's module loader (the one its context was built
    /// with), so that `__requireNpm` parses a package's entry module into the
    /// same module map its imports resolve against. A script runs entirely on
    /// one thread; [`ActiveLoader`] sets and clears it.
    static ACTIVE_LOADER: RefCell<Option<Rc<PackageLoader>>> = const { RefCell::new(None) };
}

/// Makes `loader` the running script's loader until dropped.
pub(crate) struct ActiveLoader;

impl ActiveLoader {
    pub(crate) fn set(loader: Rc<PackageLoader>) -> Self {
        ACTIVE_LOADER.with(|active| *active.borrow_mut() = Some(loader));
        Self
    }
}

impl Drop for ActiveLoader {
    fn drop(&mut self) {
        ACTIVE_LOADER.with(|active| active.borrow_mut().take());
    }
}

/// Defines the natives behind the prelude's `require` and
/// `crypto.getRandomValues`.
pub(crate) fn register_natives(context: &mut Context) -> JsResult<()> {
    context.register_global_builtin_callable(
        js_string!("__bundledSource"),
        1,
        NativeFunction::from_copy_closure(|_, args, context| {
            let name = args
                .first()
                .cloned()
                .unwrap_or_default()
                .to_string(context)?
                .to_std_string_escaped();
            Ok(bundled_source(&name)
                .map(|source| JsValue::from(JsString::from(source)))
                .unwrap_or_default())
        }),
    )?;
    context.register_global_builtin_callable(
        js_string!("__requireNpm"),
        1,
        NativeFunction::from_copy_closure(|_, args, context| {
            let name = args
                .first()
                .cloned()
                .unwrap_or_default()
                .to_string(context)?
                .to_std_string_escaped();
            let loader = ACTIVE_LOADER
                .with(|active| active.borrow().clone())
                .ok_or_else(|| JsNativeError::error().with_message("pacotes npm indisponíveis"))?;
            require_npm(&loader, &name, context)
        }),
    )?;
    context.register_global_builtin_callable(
        js_string!("__randomBytes"),
        1,
        NativeFunction::from_copy_closure(|_, args, context| {
            let length = args
                .first()
                .cloned()
                .unwrap_or_default()
                .to_length(context)?;
            let length = usize::try_from(length).unwrap_or(usize::MAX);
            if length > MAX_RANDOM_BYTES {
                return Err(JsNativeError::range()
                    .with_message(format!(
                        "crypto.getRandomValues aceita até {MAX_RANDOM_BYTES} bytes"
                    ))
                    .into());
            }
            let mut bytes = vec![0u8; length];
            getrandom::fill(&mut bytes).map_err(|error| {
                JsNativeError::error()
                    .with_message(format!("falha ao gerar bytes aleatórios: {error}"))
            })?;
            Ok(JsArray::from_iter(bytes.into_iter().map(JsValue::from), context).into())
        }),
    )?;
    Ok(())
}

/// Evaluates an npm package's entry module and returns its default export
/// (CommonJS packages), or its namespace when it has none.
fn require_npm(loader: &PackageLoader, name: &str, context: &mut Context) -> JsResult<JsValue> {
    let entry = loader.packages.entries.get(name).ok_or_else(|| {
        JsNativeError::error().with_message(format!(
            "pacote npm não disponível: {name} (só nomes literais em require são baixados)"
        ))
    })?;
    let module = loader.module(entry, context)?;
    let promise = module.load_link_evaluate(context);
    context.run_jobs()?;
    match promise.state() {
        PromiseState::Fulfilled(_) => {}
        PromiseState::Rejected(error) => {
            return Err(boa_engine::JsError::from_opaque(error));
        }
        PromiseState::Pending => {
            return Err(JsNativeError::error()
                .with_message(format!("o pacote {name} não terminou de carregar"))
                .into());
        }
    }
    let namespace = module.namespace(context);
    let default = namespace.get(js_string!("default"), context)?;
    Ok(if default.is_undefined() {
        namespace.into()
    } else {
        default
    })
}
