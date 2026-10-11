//! Execução de scripts de pré-requisição e pós-resposta (spec 0054, ADR 0018).
//!
//! O script enxerga um objeto global `al`. Toda a comunicação com o host é
//! feita por valores simples: entra um `ScriptInput`, sai um `ScriptOutput`
//! com o que o script alterou.

use boa_engine::{Context, JsError, JsValue, Source};
use thiserror::Error;

/// Limites defensivos do runtime e dos dados que atravessam o interpretador.
const LOOP_ITERATION_LIMIT: u64 = 1_000_000;
const RECURSION_LIMIT: usize = 400;
const STACK_SIZE_LIMIT: usize = 4_096;
const MAX_SCRIPT_SOURCE_BYTES: usize = 256 * 1024;
const MAX_SCRIPT_INPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_SCRIPT_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptPhase {
    PreRequest,
    PostResponse,
}

impl ScriptPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PreRequest => "preRequest",
            Self::PostResponse => "postResponse",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptRequest {
    pub url: String,
    pub method: String,
    pub body: String,
    pub headers: Vec<ScriptHeader>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptResponse {
    pub status: u16,
    pub status_text: String,
    pub time_ms: u64,
    pub size_bytes: usize,
    pub url: String,
    pub headers: Vec<ScriptHeader>,
    /// Corpo em texto; `None` quando a resposta é binária.
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptVariable {
    pub name: String,
    pub value: String,
}

/// Iteração atual quando o script roda dentro do runner de coleções
/// (spec 0073). Fora do runner o script enxerga a iteração 0 de 1, sem dados.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptIteration {
    pub index: u32,
    pub count: u32,
    /// Valores da linha do arquivo de dados desta iteração.
    pub data: Vec<ScriptVariable>,
}

impl Default for ScriptIteration {
    fn default() -> Self {
        Self {
            index: 0,
            count: 1,
            data: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptInput {
    pub request: ScriptRequest,
    pub response: Option<ScriptResponse>,
    /// Ambiente ativo (escopo global), exposto como `al.environment`.
    pub environment: Vec<ScriptVariable>,
    /// Variáveis da coleção da requisição (`al.collection`); `None` quando a
    /// requisição não está salva numa coleção.
    pub collection: Option<Vec<ScriptVariable>>,
    /// Variáveis da pasta pai direta (`al.folder`); `None` quando a
    /// requisição não está numa pasta.
    pub folder: Option<Vec<ScriptVariable>>,
    /// Variáveis locais à requisição (sobrevivem do pré ao pós).
    pub local: Vec<ScriptVariable>,
    /// Variáveis compartilhadas pelo runner/flow atual, sem persistência.
    pub runtime: Vec<ScriptVariable>,
    pub iteration: ScriptIteration,
}

/// Resultado de um `al.test(name, fn)`: passou quando `fn` não lançou.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptTestResult {
    pub name: String,
    pub passed: bool,
    /// Mensagem da falha (ex.: de um `al.expect`); `None` quando passou.
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptOutput {
    /// Requisição depois do script (igual à de entrada no pós-script).
    pub request: ScriptRequest,
    /// Ambiente completo depois do script.
    pub environment: Vec<ScriptVariable>,
    /// Nomes de variáveis gravadas por `al.environment.set`, em ordem.
    pub changed_variables: Vec<String>,
    pub removed_variables: Vec<String>,
    /// Variáveis da coleção depois do script (`None` se não havia coleção).
    pub collection: Option<Vec<ScriptVariable>>,
    /// Nomes gravados por `al.collection.set`, em ordem.
    pub changed_collection: Vec<String>,
    pub removed_collection: Vec<String>,
    /// Variáveis da pasta depois do script (`None` se não havia pasta).
    pub folder: Option<Vec<ScriptVariable>>,
    /// Nomes gravados por `al.folder.set`, em ordem.
    pub changed_folder: Vec<String>,
    pub removed_folder: Vec<String>,
    pub local: Vec<ScriptVariable>,
    pub runtime: Vec<ScriptVariable>,
    pub logs: Vec<String>,
    /// Testes registrados por `al.test`, em ordem.
    pub tests: Vec<ScriptTestResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("erro no script de {}: {message}", phase.as_str())]
pub struct ScriptError {
    pub phase: ScriptPhase,
    pub message: String,
    pub line: Option<u32>,
}

/// Prelúdio que monta o `al` sobre um único objeto `__host` (JSON) injetado
/// pelo host. Só lógica JS pura: nada de I/O.
const PRELUDE: &str = r#"
var al = (function (host) {
  var logs = [];
  var changed = [];
  var changedCollection = [];
  var changedFolder = [];
  var tests = [];
  var request = host.request;
  var headerIndex = function (name) {
    var lower = String(name).toLowerCase();
    for (var i = 0; i < request.headers.length; i++) {
      if (request.headers[i].name.toLowerCase() === lower) return i;
    }
    return -1;
  };
  var readOnly = host.phase === 'postResponse';
  var guard = function () {
    if (readOnly) throw new Error('al.request é somente leitura no script de pós-resposta');
  };
  var requestApi = {
    get url() { return request.url; },
    set url(v) { guard(); request.url = String(v); },
    get method() { return request.method; },
    set method(v) { guard(); request.method = String(v).toLowerCase(); },
    get body() { return request.body; },
    set body(v) { guard(); request.body = String(v); },
    query: {
      get: function (name) { var query=request.url.split('?')[1]||''; query=query.split('#')[0]; var parts=query.split('&'); for(var i=0;i<parts.length;i++){var pair=parts[i].split('=');if(decodeURIComponent(pair[0])===String(name))return decodeURIComponent(pair.slice(1).join('='));} return undefined; },
      has: function (name) { return this.get(name) !== undefined; },
      set: function (name, value) { guard(); this.remove(name); var hash=''; var hashAt=request.url.indexOf('#'); if(hashAt>=0){hash=request.url.slice(hashAt);request.url=request.url.slice(0,hashAt);} request.url += (request.url.indexOf('?')>=0?'&':'?')+encodeURIComponent(String(name))+'='+encodeURIComponent(String(value)); request.url+=hash; },
      add: function (name, value) { guard(); var o=name; if(typeof o==='object'){for(var k in o)this.set(k,o[k]);}else this.set(name,value); },
      remove: function (name) { guard(); var hash=''; var hashAt=request.url.indexOf('#'); if(hashAt>=0){hash=request.url.slice(hashAt);request.url=request.url.slice(0,hashAt);} var pieces=request.url.split('?'); if(pieces.length<2)return; var kept=pieces[1].split('&').filter(function(p){return decodeURIComponent(p.split('=')[0])!==String(name);}); request.url=pieces[0]+(kept.length?'?'+kept.join('&'):'')+hash; },
      toObject: function () { var o={}; var query=request.url.split('?')[1]||''; query.split('#')[0].split('&').forEach(function(p){if(!p)return;var pair=p.split('=');o[decodeURIComponent(pair[0])]=decodeURIComponent(pair.slice(1).join('='));}); return o; }
    },
    headers: {
      get: function (name) {
        var i = headerIndex(name);
        return i < 0 ? undefined : request.headers[i].value;
      },
      set: function (name, value) {
        guard();
        var i = headerIndex(name);
        if (i < 0) request.headers.push({ name: String(name), value: String(value) });
        else request.headers[i].value = String(value);
      },
      remove: function (name) {
        guard(); var i = headerIndex(name); if (i >= 0) request.headers.splice(i, 1);
      },
      has: function (name) { return headerIndex(name) >= 0; },
      toObject: function () { var o = {}; for (var i=0;i<request.headers.length;i++) o[request.headers[i].name]=request.headers[i].value; return o; },
      setAll: function (values) { guard(); for (var k in values) this.set(k, values[k]); },
      removeAll: function () { guard(); request.headers.splice(0, request.headers.length); }
    },
    getUrl: function () { return request.url; }, setUrl: function (v) { requestApi.url = v; },
    getMethod: function () { return request.method; }, setMethod: function (v) { requestApi.method = v; },
    getBody: function () { return request.body; }, setBody: function (v) { requestApi.body = typeof v === 'string' ? v : JSON.stringify(v); },
    json: function () { return JSON.parse(request.body); },
    setJson: function (v) { requestApi.body = JSON.stringify(v); }
  };
  var responseApi;
  if (host.response) {
    var res = host.response;
    responseApi = {
      status: res.status,
      statusText: res.statusText || '', time: res.time, size: res.size || (res.body ? res.body.length : 0),
      url: res.url || request.url, body: res.body,
      getStatus: function () { return this.status; }, getStatusText: function () { return this.statusText; },
      getTime: function () { return this.time; }, getSize: function () { return this.size; },
      getUrl: function () { return this.url; }, getBody: function () { return this.body; },
      headers: {
        get: function (name) {
          var lower = String(name).toLowerCase();
          for (var i = 0; i < res.headers.length; i++) {
            if (res.headers[i].name.toLowerCase() === lower) return res.headers[i].value;
          }
          return undefined;
        },
        has: function (name) { return this.get(name) !== undefined; },
        toObject: function () { var o={}; for(var i=0;i<res.headers.length;i++)o[res.headers[i].name]=res.headers[i].value; return o; }
      },
      text: function () {
        if (res.body === null) throw new Error('a resposta é binária e não pode ser lida como texto');
        return res.body;
      },
      // Uma interpretação nova a cada chamada: scripts (inclusive os
      // importados de outras ferramentas) contam com um objeto próprio, que
      // podem alterar (ex.: `sort()`) sem afetar a próxima chamada.
      json: function () { return JSON.parse(this.text()); }
    };
  }
  // `vars` nulo = escopo ausente: `get` devolve undefined e `set` lança.
  var makeScope = function (vars, changedNames, missing) {
    return {
      get: function (name) {
        if (!vars) return undefined;
        var v = vars[String(name)];
        return v === undefined ? undefined : v;
      },
      set: function (name, value) {
        if (!vars) throw new Error(missing);
        name = String(name);
        vars[name] = typeof value === 'string' ? value : JSON.stringify(value);
        if (changedNames.indexOf(name) < 0) {
          if (changedNames.length >= 10000) throw new Error('limite de alterações do script excedido');
          changedNames.push(name);
        }
      },
      has: function (name) { return !!vars && Object.prototype.hasOwnProperty.call(vars, String(name)); },
      unset: function (name) {
        if (!vars) throw new Error(missing);
        name = String(name); delete vars[name];
        if (changedNames.indexOf(name) < 0) changedNames.push(name);
      },
      clear: function () {
        if (!vars) throw new Error(missing);
        var keys = Object.keys(vars); for (var i = 0; i < keys.length; i++) this.unset(keys[i]);
      },
      toObject: function () { var copy = {}; if (vars) for (var k in vars) copy[k] = vars[k]; return copy; },
      replaceIn: function (text) {
        return String(text).replace(/\{\{([^}]+)\}\}/g, function (_, name) {
          var value = vars && vars[String(name).trim()]; return value === undefined ? _ : value;
        });
      }
    };
  };
  var environmentApi = makeScope(host.environment, changed, null);
  var collectionApi = makeScope(host.collection, changedCollection,
    'al.collection: a requisição não está salva em uma coleção');
  var folderApi = makeScope(host.folder, changedFolder,
    'al.folder: a requisição não está em uma pasta');
  var format = function (v) {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  };
  var show = function (v) {
    if (v === undefined) return 'undefined';
    if (typeof v === 'function') return 'function';
    try {
      var s = JSON.stringify(v);
      return s === undefined ? String(v) : s;
    } catch (e) { return String(v); }
  };
  var deepEqual = function (a, b) {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number' && a !== a && b !== b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    var ka = Object.keys(a);
    var kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(b, ka[i])) return false;
      if (!deepEqual(a[ka[i]], b[ka[i]])) return false;
    }
    return true;
  };
  var readPath = function (target, path) {
    var parts = Array.isArray(path)
      ? path
      : String(path).replace(/\[(\d+)\]/g, '.$1').split('.');
    var current = target;
    for (var i = 0; i < parts.length; i++) {
      if (current === null || current === undefined) return { found: false };
      var boxed = Object(current);
      if (!(parts[i] in boxed)) return { found: false };
      current = boxed[parts[i]];
    }
    return { found: true, value: current };
  };
  var assertionError = function (message) {
    var error = new Error(message);
    error.name = 'AssertionError';
    return error;
  };
  var makeExpect = function (actual, negated) {
    var check = function (pass, message, negatedMessage) {
      if (pass === negated) throw assertionError(negated ? negatedMessage : message);
    };
    var got = function () { return ', recebido ' + show(actual); };
    var matchers = {
      toBe: function (expected) {
        check(actual === expected,
          'esperado ' + show(expected) + got(),
          'esperado valor diferente de ' + show(expected));
      },
      toEqual: function (expected) {
        check(deepEqual(actual, expected),
          'esperado igual a ' + show(expected) + got(),
          'esperado diferente de ' + show(expected));
      },
      toBeTruthy: function () {
        check(!!actual, 'esperado valor verdadeiro' + got(), 'esperado valor falso' + got());
      },
      toBeFalsy: function () {
        check(!actual, 'esperado valor falso' + got(), 'esperado valor verdadeiro' + got());
      },
      toBeDefined: function () {
        check(actual !== undefined, 'esperado valor definido', 'esperado undefined' + got());
      },
      toBeNull: function () {
        check(actual === null, 'esperado null' + got(), 'esperado valor diferente de null');
      },
      toContain: function (item) {
        var pass;
        if (typeof actual === 'string') pass = actual.indexOf(String(item)) >= 0;
        else if (Array.isArray(actual)) {
          pass = false;
          for (var i = 0; i < actual.length; i++) {
            if (deepEqual(actual[i], item)) { pass = true; break; }
          }
        } else throw assertionError('toContain espera texto ou lista' + got());
        check(pass,
          'esperado conter ' + show(item) + got(),
          'esperado não conter ' + show(item) + got());
      },
      toMatch: function (pattern) {
        var regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern));
        check(regex.test(String(actual)),
          'esperado corresponder a ' + String(regex) + got(),
          'esperado não corresponder a ' + String(regex) + got());
      },
      toBeGreaterThan: function (n) {
        check(actual > n, 'esperado maior que ' + show(n) + got(), 'esperado não ser maior que ' + show(n) + got());
      },
      toBeLessThan: function (n) {
        check(actual < n, 'esperado menor que ' + show(n) + got(), 'esperado não ser menor que ' + show(n) + got());
      },
      toHaveLength: function (n) {
        var length = actual === null || actual === undefined ? undefined : actual.length;
        check(length === n,
          'esperado tamanho ' + show(n) + ', recebido ' + show(length),
          'esperado tamanho diferente de ' + show(n));
      },
      toHaveProperty: function (path, value) {
        var result = readPath(actual, path);
        if (arguments.length < 2) {
          check(result.found,
            'esperado ter a propriedade ' + show(path),
            'esperado não ter a propriedade ' + show(path));
        } else {
          check(result.found && deepEqual(result.value, value),
            'esperado ' + show(path) + ' igual a ' + show(value) +
              (result.found ? ', recebido ' + show(result.value) : ', mas a propriedade não existe'),
            'esperado ' + show(path) + ' diferente de ' + show(value));
        }
      }
    };
    matchers.equal = matchers.toBe; matchers.eql = matchers.toEqual;
    matchers.include = matchers.toContain; matchers.match = matchers.toMatch;
    matchers.above = matchers.toBeGreaterThan; matchers.below = matchers.toBeLessThan;
    matchers.lengthOf = matchers.toHaveLength; matchers.property = matchers.toHaveProperty;
    matchers.oneOf = function (values) { var pass=false; for(var i=0;i<values.length;i++){if(deepEqual(actual,values[i])){pass=true;break;}} check(pass, 'esperado pertencer à lista' + got(), 'esperado não pertencer à lista' + got()); };
    matchers.a = matchers.an = function (kind) { var type = Array.isArray(actual) ? 'array' : typeof actual; check(type === String(kind).toLowerCase(), 'esperado tipo ' + kind + got(), 'esperado tipo diferente de ' + kind); };
    matchers.to = matchers; matchers.be = matchers; matchers.have = matchers;
    if (!negated) matchers.not = makeExpect(actual, true);
    return matchers;
  };
  var iteration = host.iteration;
  var localVariables = host.local;
  var runtimeVariables = host.runtime;
  var localScope = makeScope(localVariables, [], null);
  var variablesApi = {
    get: function (name) {
      if (localScope.has(name)) return localScope.get(name);
      if (folderApi.has(name)) return folderApi.get(name);
      if (collectionApi.has(name)) return collectionApi.get(name);
      return environmentApi.get(name);
    },
    set: localScope.set, has: function (name) { return this.get(name) !== undefined; },
    unset: localScope.unset, clear: localScope.clear, toObject: function () {
      var result = environmentApi.toObject(); var layers = [collectionApi.toObject(), folderApi.toObject(), localScope.toObject()];
      for (var i=0;i<layers.length;i++) for(var key in layers[i]) result[key]=layers[i][key]; return result;
    },
    replaceIn: function (text) { var self=this; return String(text).replace(/\{\{([^}]+)\}\}/g, function (_, name) { var value=self.get(String(name).trim()); return value === undefined ? _ : value; }); }
  };
  var runtimeApi = makeScope(runtimeVariables, [], null);
  var api = {
    request: requestApi,
    environment: environmentApi,
    collection: collectionApi,
    folder: folderApi,
    variables: variablesApi, runtime: runtimeApi,
    info: { phase: host.phase, iteration: iteration.index, iterationCount: iteration.count },
    iteration: { index: iteration.index, count: iteration.count },
    iterationData: {
      get: function (name) {
        var v = iteration.data[String(name)];
        return v === undefined ? undefined : v;
      },
      toObject: function () {
        var copy = {};
        for (var k in iteration.data) copy[k] = iteration.data[k];
        return copy;
      }
    },
    test: function (name, fn) {
      if (tests.length >= 10000) throw new Error('limite de testes do script excedido');
      var entry = { name: String(name), passed: true, message: null };
      try {
        if (typeof fn !== 'function') throw new Error('al.test espera uma função');
        fn();
      } catch (e) {
        entry.passed = false;
        entry.message = e && e.message !== undefined ? String(e.message) : String(e);
      }
      tests.push(entry);
    },
    expect: function (actual) { return makeExpect(actual, false); },
    unsupported: function (name) { throw new Error('API incompatível no sandbox: ' + String(name)); },
    unsupportedCommand: function (name) { return function () { throw new Error('API incompatível no sandbox: ' + String(name)); }; },
    console: { log: function () {
      if (logs.length >= 1000) return;
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(format(arguments[i]));
      var message = parts.join(' ');
      if (message.length > 16384) message = message.slice(0, 16384) + '…';
      logs.push(message);
    } }
  };
  api.console.info = api.console.log; api.console.warn = api.console.log; api.console.error = api.console.log;
  if (responseApi) api.response = responseApi;
  api.__state = function () {
    return JSON.stringify({
      request: request,
      environment: host.environment,
      changed: changed,
      collection: host.collection,
      changedCollection: changedCollection,
      folder: host.folder,
      changedFolder: changedFolder,
      local: localVariables,
      runtime: runtimeVariables,
      logs: logs,
      tests: tests
    });
  };
  return api;
})(JSON.parse(__hostJson));
"#;

pub fn run_script(
    phase: ScriptPhase,
    source: &str,
    input: &ScriptInput,
) -> Result<ScriptOutput, ScriptError> {
    let fail = |message: String, line: Option<u32>| ScriptError {
        phase,
        message,
        line,
    };

    if source.len() > MAX_SCRIPT_SOURCE_BYTES {
        return Err(fail(
            format!(
                "código excede o limite de {} KiB",
                MAX_SCRIPT_SOURCE_BYTES / 1024
            ),
            None,
        ));
    }

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

    // Os corpos entram no contexto no mínimo com o próprio tamanho (o JSON
    // só acrescenta escapes): passando do limite, falha antes de montar o
    // contexto, que chegava a ocupar algumas vezes o tamanho do corpo só para
    // ser recusado logo depois.
    let raw_bodies_len = input.request.body.len()
        + input
            .response
            .as_ref()
            .and_then(|response| response.body.as_ref())
            .map_or(0, String::len);
    let host_json = if raw_bodies_len > MAX_SCRIPT_INPUT_BYTES {
        None
    } else {
        Some(host_json(phase, input))
    };
    let Some(host_json) = host_json.filter(|json| json.len() <= MAX_SCRIPT_INPUT_BYTES) else {
        return Err(fail(
            format!(
                "contexto excede o limite de {} MiB",
                MAX_SCRIPT_INPUT_BYTES / (1024 * 1024)
            ),
            None,
        ));
    };
    let host_literal = serde_json::Value::String(host_json).to_string();
    context
        .eval(Source::from_bytes(&format!(
            "var __hostJson = {host_literal};"
        )))
        .map_err(|error| fail(describe(&error, &mut context), None))?;
    context
        .eval(Source::from_bytes(PRELUDE))
        .map_err(|error| fail(describe(&error, &mut context), None))?;

    // O script do usuário roda em uma avaliação própria, separada do
    // prelúdio, para que mensagens de erro se refiram só ao código dele.
    context.eval(Source::from_bytes(source)).map_err(|error| {
        let message = describe(&error, &mut context);
        fail(message, None)
    })?;

    let state = context
        .eval(Source::from_bytes("al.__state()"))
        .map_err(|error| fail(describe(&error, &mut context), None))?;
    let state_json = state
        .as_string()
        .map(|s| s.to_std_string_escaped())
        .ok_or_else(|| fail("estado do script inválido".to_string(), None))?;
    if state_json.len() > MAX_SCRIPT_OUTPUT_BYTES {
        return Err(fail(
            format!(
                "resultado excede o limite de {} MiB",
                MAX_SCRIPT_OUTPUT_BYTES / (1024 * 1024)
            ),
            None,
        ));
    }
    parse_state(&state_json).ok_or_else(|| fail("estado do script inválido".to_string(), None))
}

fn describe(error: &JsError, context: &mut Context) -> String {
    match error.try_native(context) {
        Ok(native) => native.to_string(),
        Err(_) => error
            .as_opaque()
            .map(JsValue::display)
            .map(|d| d.to_string())
            .unwrap_or_else(|| "erro desconhecido".to_string()),
    }
}

fn host_json(phase: ScriptPhase, input: &ScriptInput) -> String {
    use serde_json::{Map, Value, json};
    let headers = |headers: &[ScriptHeader]| -> Vec<Value> {
        headers
            .iter()
            .map(|h| json!({ "name": h.name, "value": h.value }))
            .collect()
    };
    let object = |variables: &[ScriptVariable]| -> Map<String, Value> {
        variables
            .iter()
            .map(|variable| (variable.name.clone(), Value::String(variable.value.clone())))
            .collect()
    };
    let environment = object(&input.environment);
    let collection = input.collection.as_deref().map(object);
    let folder = input.folder.as_deref().map(object);
    let local = object(&input.local);
    let runtime = object(&input.runtime);
    let response = input.response.as_ref().map(|r| {
        json!({
            "status": r.status,
            "statusText": r.status_text,
            "time": r.time_ms,
            "size": r.size_bytes,
            "url": r.url,
            "headers": headers(&r.headers),
            "body": r.body,
        })
    });
    let mut iteration_data = Map::new();
    for variable in &input.iteration.data {
        iteration_data.insert(variable.name.clone(), Value::String(variable.value.clone()));
    }
    json!({
        "phase": phase.as_str(),
        "request": {
            "url": input.request.url,
            "method": input.request.method,
            "body": input.request.body,
            "headers": headers(&input.request.headers),
        },
        "response": response,
        "environment": environment,
        "collection": collection,
        "folder": folder,
        "local": local,
        "runtime": runtime,
        "iteration": {
            "index": input.iteration.index,
            "count": input.iteration.count,
            "data": iteration_data,
        },
    })
    .to_string()
}

fn parse_state(json: &str) -> Option<ScriptOutput> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let request = value.get("request")?;
    let headers = request
        .get("headers")?
        .as_array()?
        .iter()
        .map(|h| {
            Some(ScriptHeader {
                name: h.get("name")?.as_str()?.to_string(),
                value: h.get("value")?.as_str()?.to_string(),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let variables = |object: &serde_json::Map<String, serde_json::Value>| {
        object
            .iter()
            .map(|(name, v)| {
                Some(ScriptVariable {
                    name: name.clone(),
                    value: v.as_str()?.to_string(),
                })
            })
            .collect::<Option<Vec<_>>>()
    };
    // Escopo local ausente chega como `null`.
    let optional_variables = |key: &str| -> Option<Option<Vec<ScriptVariable>>> {
        match value.get(key)? {
            serde_json::Value::Null => Some(None),
            other => variables(other.as_object()?).map(Some),
        }
    };
    let environment = variables(value.get("environment")?.as_object()?)?;
    let collection = optional_variables("collection")?;
    let folder = optional_variables("folder")?;
    let local = variables(value.get("local")?.as_object()?)?;
    let runtime = variables(value.get("runtime")?.as_object()?)?;
    let strings = |key: &str| -> Option<Vec<String>> {
        value
            .get(key)?
            .as_array()?
            .iter()
            .map(|v| v.as_str().map(str::to_string))
            .collect()
    };
    let tests = value
        .get("tests")?
        .as_array()?
        .iter()
        .map(|t| {
            Some(ScriptTestResult {
                name: t.get("name")?.as_str()?.to_string(),
                passed: t.get("passed")?.as_bool()?,
                message: t
                    .get("message")
                    .and_then(|m| m.as_str())
                    .map(str::to_string),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(ScriptOutput {
        request: ScriptRequest {
            url: request.get("url")?.as_str()?.to_string(),
            method: request.get("method")?.as_str()?.to_string(),
            body: request.get("body")?.as_str()?.to_string(),
            headers,
        },
        removed_variables: strings("changed")?
            .into_iter()
            .filter(|name| !environment.iter().any(|variable| &variable.name == name))
            .collect(),
        environment,
        changed_variables: strings("changed")?,
        removed_collection: strings("changedCollection")?
            .into_iter()
            .filter(|name| {
                collection
                    .as_ref()
                    .is_some_and(|values| !values.iter().any(|variable| &variable.name == name))
            })
            .collect(),
        collection,
        changed_collection: strings("changedCollection")?,
        removed_folder: strings("changedFolder")?
            .into_iter()
            .filter(|name| {
                folder
                    .as_ref()
                    .is_some_and(|values| !values.iter().any(|variable| &variable.name == name))
            })
            .collect(),
        folder,
        changed_folder: strings("changedFolder")?,
        local,
        runtime,
        logs: strings("logs")?,
        tests,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> ScriptInput {
        ScriptInput {
            request: ScriptRequest {
                url: "https://api.example.com/users".to_string(),
                method: "get".to_string(),
                body: String::new(),
                headers: vec![ScriptHeader {
                    name: "Accept".to_string(),
                    value: "application/json".to_string(),
                }],
            },
            response: None,
            environment: vec![ScriptVariable {
                name: "token".to_string(),
                value: "abc".to_string(),
            }],
            collection: None,
            folder: None,
            local: Vec::new(),
            runtime: Vec::new(),
            iteration: ScriptIteration::default(),
        }
    }

    fn vars(pairs: &[(&str, &str)]) -> Vec<ScriptVariable> {
        pairs
            .iter()
            .map(|(name, value)| ScriptVariable {
                name: name.to_string(),
                value: value.to_string(),
            })
            .collect()
    }

    #[test]
    fn collection_and_folder_scopes_are_separate_from_the_environment() {
        let mut input = input();
        input.collection = Some(vars(&[("baseUrl", "collection")]));
        input.folder = Some(vars(&[("id", "7")]));

        let out = run_script(
            ScriptPhase::PreRequest,
            "al.request.body = [al.environment.get('baseUrl'), al.collection.get('baseUrl'), \
             al.folder.get('id'), al.folder.get('token')].join(',');\n\
             al.collection.set('baseUrl', 'changed');\n\
             al.folder.set('created', 1);",
            &input,
        )
        .unwrap();

        assert_eq!(out.request.body, ",collection,7,");
        assert_eq!(out.changed_collection, vec!["baseUrl"]);
        assert_eq!(out.changed_folder, vec!["created"]);
        assert!(out.changed_variables.is_empty());
        assert!(
            out.collection
                .unwrap()
                .contains(&vars(&[("baseUrl", "changed")])[0])
        );
        assert!(out.folder.unwrap().contains(&vars(&[("created", "1")])[0]));
        assert_eq!(out.environment, vars(&[("token", "abc")]));
    }

    #[test]
    fn a_missing_scope_reads_undefined_and_rejects_writes() {
        let out = run_script(
            ScriptPhase::PreRequest,
            "al.request.body = String(al.folder.get('x')) + String(al.collection.get('x'));",
            &input(),
        )
        .unwrap();
        assert_eq!(out.request.body, "undefinedundefined");
        assert_eq!(out.collection, None);
        assert_eq!(out.folder, None);

        let error =
            run_script(ScriptPhase::PreRequest, "al.folder.set('x', 1);", &input()).unwrap_err();
        assert!(error.message.contains("não está em uma pasta"));
        let error = run_script(
            ScriptPhase::PreRequest,
            "al.collection.set('x', 1);",
            &input(),
        )
        .unwrap_err();
        assert!(error.message.contains("não está salva em uma coleção"));
    }

    fn with_response(body: Option<&str>) -> ScriptInput {
        let mut input = input();
        input.response = Some(ScriptResponse {
            status: 201,
            status_text: "Created".to_string(),
            time_ms: 42,
            size_bytes: body.map(str::len).unwrap_or_default(),
            url: "https://api.example.com/users".to_string(),
            headers: vec![ScriptHeader {
                name: "Content-Type".to_string(),
                value: "application/json".to_string(),
            }],
            body: body.map(str::to_string),
        });
        input
    }

    #[test]
    fn pre_script_changes_url_headers_and_body() {
        let script = r#"
            al.request.url = al.request.url + '?a=1';
            al.request.headers.set('X-Token', al.environment.get('token'));
            al.request.headers.set('accept', 'text/plain');
            al.request.body = '{"x":1}';
        "#;

        let out = run_script(ScriptPhase::PreRequest, script, &input()).unwrap();

        assert_eq!(out.request.url, "https://api.example.com/users?a=1");
        assert_eq!(out.request.body, "{\"x\":1}");
        assert_eq!(out.request.headers.len(), 2);
        assert_eq!(out.request.headers[0].value, "text/plain");
        assert_eq!(out.request.headers[1].name, "X-Token");
        assert_eq!(out.request.headers[1].value, "abc");
    }

    #[test]
    fn pre_script_can_remove_a_header() {
        let out = run_script(
            ScriptPhase::PreRequest,
            "al.request.headers.remove('ACCEPT');",
            &input(),
        )
        .unwrap();

        assert!(out.request.headers.is_empty());
    }

    #[test]
    fn response_json_returns_a_fresh_object_on_each_call() {
        let script = r#"
            var first = al.response.json();
            first.marked = true;
            al.environment.set('same', String(al.response.json() === first));
            al.environment.set('marked', String(al.response.json().marked));
        "#;

        let out = run_script(
            ScriptPhase::PostResponse,
            script,
            &with_response(Some("{\"id\":7}")),
        )
        .unwrap();

        let value = |name: &str| {
            out.environment
                .iter()
                .find(|variable| variable.name == name)
                .map(|variable| variable.value.clone())
        };
        assert_eq!(value("same").as_deref(), Some("false"));
        assert_eq!(value("marked").as_deref(), Some("undefined"));
    }

    #[test]
    fn a_response_body_over_the_input_limit_fails_before_running() {
        let body = "x".repeat(MAX_SCRIPT_INPUT_BYTES + 1);

        let error = run_script(
            ScriptPhase::PostResponse,
            "al.environment.set('ran', 'yes')",
            &with_response(Some(&body)),
        )
        .unwrap_err();

        assert!(
            error.message.contains("contexto excede o limite"),
            "{}",
            error.message
        );
    }

    #[test]
    fn post_script_reads_the_response_and_sets_the_environment() {
        let script = r#"
            al.environment.set('id', String(al.response.json().id));
            al.environment.set('status', al.response.status);
            al.console.log('tempo', al.response.time, {a: 1});
        "#;

        let out = run_script(
            ScriptPhase::PostResponse,
            script,
            &with_response(Some("{\"id\":7}")),
        )
        .unwrap();

        assert_eq!(out.changed_variables, vec!["id", "status"]);
        let value = |name: &str| {
            out.environment
                .iter()
                .find(|v| v.name == name)
                .map(|v| v.value.clone())
        };
        assert_eq!(value("id").as_deref(), Some("7"));
        assert_eq!(value("status").as_deref(), Some("201"));
        assert_eq!(value("token").as_deref(), Some("abc"));
        assert_eq!(out.logs, vec!["tempo 42 {\"a\":1}"]);
    }

    #[test]
    fn post_script_cannot_change_the_request() {
        let error = run_script(
            ScriptPhase::PostResponse,
            "al.request.url = 'x';",
            &with_response(Some("")),
        )
        .unwrap_err();

        assert_eq!(error.phase, ScriptPhase::PostResponse);
        assert!(
            error.message.contains("somente leitura"),
            "{}",
            error.message
        );
    }

    #[test]
    fn binary_response_cannot_be_read_as_text() {
        let error = run_script(
            ScriptPhase::PostResponse,
            "al.response.text();",
            &with_response(None),
        )
        .unwrap_err();

        assert!(error.message.contains("binária"), "{}", error.message);
    }

    #[test]
    fn reports_syntax_errors() {
        let error = run_script(ScriptPhase::PreRequest, "var = ;", &input()).unwrap_err();

        assert_eq!(error.phase, ScriptPhase::PreRequest);
        assert!(!error.message.is_empty());
    }

    #[test]
    fn reports_runtime_errors() {
        let error = run_script(ScriptPhase::PreRequest, "undefinedFn();", &input()).unwrap_err();

        assert!(error.message.contains("undefinedFn"), "{}", error.message);
    }

    #[test]
    fn stops_infinite_loops() {
        let error = run_script(ScriptPhase::PreRequest, "while (true) {}", &input()).unwrap_err();

        assert_eq!(error.phase, ScriptPhase::PreRequest);
    }

    #[test]
    fn rejects_source_larger_than_the_configured_limit() {
        let source = " ".repeat(MAX_SCRIPT_SOURCE_BYTES + 1);
        let error = run_script(ScriptPhase::PreRequest, &source, &input()).unwrap_err();

        assert!(error.message.contains("código excede o limite"));
    }

    #[test]
    fn rejects_output_larger_than_the_configured_limit() {
        let mut input = input();
        input.request.body = "x".repeat(MAX_SCRIPT_OUTPUT_BYTES);
        let error = run_script(ScriptPhase::PreRequest, "", &input).unwrap_err();

        assert!(
            error.message.contains("resultado excede o limite"),
            "{}",
            error.message
        );
    }

    #[test]
    fn limits_log_count_and_entry_size() {
        let out = run_script(
            ScriptPhase::PreRequest,
            "al.console.log('x'.repeat(20000));\n\
             for (var i = 0; i < 1100; i++) al.console.log(i);",
            &input(),
        )
        .unwrap();

        assert_eq!(out.logs.len(), 1000);
        assert_eq!(out.logs[0].chars().count(), 16_385);
        assert!(out.logs[0].ends_with('…'));
    }

    #[test]
    fn missing_environment_variable_is_undefined() {
        let out = run_script(
            ScriptPhase::PreRequest,
            "al.request.body = String(al.environment.get('nope'));",
            &input(),
        )
        .unwrap();

        assert_eq!(out.request.body, "undefined");
    }

    fn run_tests(script: &str) -> Vec<ScriptTestResult> {
        run_script(
            ScriptPhase::PostResponse,
            script,
            &with_response(Some(
                "{\"id\":7,\"user\":{\"name\":\"Ana\",\"tags\":[\"a\",\"b\"]}}",
            )),
        )
        .unwrap()
        .tests
    }

    fn outcomes(tests: &[ScriptTestResult]) -> Vec<bool> {
        tests.iter().map(|t| t.passed).collect()
    }

    #[test]
    fn test_passes_when_the_function_does_not_throw() {
        let tests = run_tests(
            "al.test('status 201', function () { al.expect(al.response.status).toBe(201); });",
        );

        assert_eq!(
            tests,
            vec![ScriptTestResult {
                name: "status 201".to_string(),
                passed: true,
                message: None,
            }]
        );
    }

    #[test]
    fn failed_expectation_records_a_readable_message() {
        let tests = run_tests(
            "al.test('status', function () { al.expect(al.response.status).toBe(200); });",
        );

        assert!(!tests[0].passed);
        assert_eq!(
            tests[0].message.as_deref(),
            Some("esperado 200, recebido 201")
        );
    }

    #[test]
    fn a_throwing_test_does_not_stop_the_script() {
        let tests = run_tests(
            "al.test('a', function () { throw new Error('boom'); });\n\
             al.test('b', function () {});",
        );

        assert_eq!(outcomes(&tests), vec![false, true]);
        assert_eq!(tests[0].message.as_deref(), Some("boom"));
    }

    #[test]
    fn matchers_cover_common_assertions() {
        let tests = run_tests(
            r#"
            var body = al.response.json();
            al.test('toEqual', function () { al.expect(body.user.tags).toEqual(['a', 'b']); });
            al.test('toBeTruthy', function () { al.expect(body.id).toBeTruthy(); });
            al.test('toBeFalsy', function () { al.expect(body.missing).toBeFalsy(); });
            al.test('toBeDefined', function () { al.expect(body.user).toBeDefined(); });
            al.test('toBeNull', function () { al.expect(null).toBeNull(); });
            al.test('toContain string', function () { al.expect(body.user.name).toContain('An'); });
            al.test('toContain array', function () { al.expect(body.user.tags).toContain('b'); });
            al.test('toMatch', function () { al.expect(body.user.name).toMatch(/^A/); });
            al.test('toMatch string', function () { al.expect('abc').toMatch('b'); });
            al.test('toBeGreaterThan', function () { al.expect(body.id).toBeGreaterThan(5); });
            al.test('toBeLessThan', function () { al.expect(body.id).toBeLessThan(8); });
            al.test('toHaveLength', function () { al.expect(body.user.tags).toHaveLength(2); });
            al.test('toHaveProperty', function () { al.expect(body).toHaveProperty('user.tags[1]', 'b'); });
            al.test('toHaveProperty only', function () { al.expect(body).toHaveProperty('user.name'); });
            "#,
        );

        let failed: Vec<_> = tests.iter().filter(|t| !t.passed).collect();
        assert!(failed.is_empty(), "falharam: {failed:?}");
        assert_eq!(tests.len(), 14);
    }

    #[test]
    fn not_inverts_matchers() {
        let tests = run_tests(
            r#"
            al.test('ok', function () { al.expect(1).not.toBe(2); });
            al.test('fail', function () { al.expect(1).not.toBe(1); });
            al.test('missing', function () { al.expect({}).not.toHaveProperty('x'); });
            "#,
        );

        assert_eq!(outcomes(&tests), vec![true, false, true]);
        assert_eq!(
            tests[1].message.as_deref(),
            Some("esperado valor diferente de 1")
        );
    }

    #[test]
    fn missing_property_is_explained() {
        let tests =
            run_tests("al.test('p', function () { al.expect({a: 1}).toHaveProperty('b', 2); });");

        assert_eq!(
            tests[0].message.as_deref(),
            Some("esperado \"b\" igual a 2, mas a propriedade não existe")
        );
    }

    #[test]
    fn tests_also_work_in_the_pre_request_script() {
        let out = run_script(
            ScriptPhase::PreRequest,
            "al.test('token', function () { al.expect(al.environment.get('token')).toBe('abc'); });",
            &input(),
        )
        .unwrap();

        assert_eq!(outcomes(&out.tests), vec![true]);
    }

    #[test]
    fn iteration_and_its_data_are_visible() {
        let mut input = input();
        input.iteration = ScriptIteration {
            index: 2,
            count: 3,
            data: vec![ScriptVariable {
                name: "user".to_string(),
                value: "ana".to_string(),
            }],
        };

        let out = run_script(
            ScriptPhase::PreRequest,
            "al.request.body = al.iteration.index + '/' + al.iteration.count + ':' + \
             al.iterationData.get('user') + ':' + al.iterationData.get('nope');",
            &input,
        )
        .unwrap();

        assert_eq!(out.request.body, "2/3:ana:undefined");
    }

    #[test]
    fn outside_the_runner_iteration_is_zero_of_one() {
        let out = run_script(
            ScriptPhase::PreRequest,
            "al.request.body = al.iteration.index + '/' + al.iteration.count + ' ' + \
             JSON.stringify(al.iterationData.toObject());",
            &input(),
        )
        .unwrap();

        assert_eq!(out.request.body, "0/1 {}");
    }

    #[test]
    fn variables_resolve_scopes_and_unset_is_typed() {
        let mut context = input();
        context.collection = Some(vars(&[("name", "collection")]));
        context.folder = Some(vars(&[("name", "folder")]));
        let output = run_script(
            ScriptPhase::PreRequest,
            "al.expect(al.variables.get('name')).toBe('folder'); al.variables.set('json', { ok: true }); al.environment.unset('token');",
            &context,
        ).unwrap();

        assert_eq!(output.local, vars(&[("json", "{\"ok\":true}")]));
        assert_eq!(output.removed_variables, vec!["token"]);
        assert!(output.environment.is_empty());
    }

    #[test]
    fn runtime_values_are_returned_to_the_host() {
        let output = run_script(
            ScriptPhase::PreRequest,
            "al.runtime.set('token', 'shared');",
            &input(),
        )
        .unwrap();

        assert_eq!(output.runtime, vars(&[("token", "shared")]));
    }

    #[test]
    fn response_exposes_transport_metadata_and_chai_aliases() {
        let context = with_response(Some("{\"ok\":true}"));
        let output = run_script(
            ScriptPhase::PostResponse,
            "al.test('metadata', function () { al.expect(al.response.statusText).equal('Created'); al.expect(al.response.size).above(0); al.expect(al.response.url).match(/^https:/); });",
            &context,
        ).unwrap();
        assert!(output.tests[0].passed, "{:?}", output.tests[0].message);
    }
}
