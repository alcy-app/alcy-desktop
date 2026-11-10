//! Pre-request/post-response scripting using global al and plain host input/output values (spec 0054, ADR 0018).

use std::rc::Rc;
use std::sync::Arc;

use boa_engine::{Context, JsError, JsValue, Source};
use thiserror::Error;

mod packages;

pub use packages::{NPM_PREFIX, ScriptPackages, npm_requests, resolve_specifier};

/// Limites defensivos do runtime e dos dados que atravessam o interpretador.
const LOOP_ITERATION_LIMIT: u64 = 1_000_000;
const RECURSION_LIMIT: usize = 400;
const STACK_SIZE_LIMIT: usize = 4_096;
const MAX_SCRIPT_SOURCE_BYTES: usize = 256 * 1024;
const MAX_SCRIPT_INPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_SCRIPT_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// Native stack of the thread a script runs on. Boa's parser and module
/// linking recurse on the native stack, outside its own recursion limit:
/// real npm bundles need more than the 2 MiB of a default worker thread, and
/// overflowing aborts the whole process (spec 0128).
const SCRIPT_THREAD_STACK_BYTES: usize = 16 * 1024 * 1024;

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
pub struct ScriptGrpcRequest {
    pub service: String,
    pub method: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptGrpcResponse {
    pub code: i32,
    pub code_name: String,
    pub message: String,
    pub trailers: Vec<ScriptHeader>,
}

/// What a WebSocket request offers (spec 0140); the message is the body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptWebSocketRequest {
    pub subprotocols: Vec<String>,
}

/// How a WebSocket connection ended; the received messages are the body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptWebSocketResponse {
    pub close_code: Option<u16>,
    pub close_reason: String,
    /// `client`, `server`, `transport` or `rejected`.
    pub closed_by: String,
    pub subprotocol: Option<String>,
    pub sent: u32,
    pub received: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptRequest {
    pub grpc: Option<ScriptGrpcRequest>,
    pub websocket: Option<ScriptWebSocketRequest>,
    pub url: String,
    pub method: String,
    pub body: String,
    pub headers: Vec<ScriptHeader>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptResponse {
    pub grpc: Option<ScriptGrpcResponse>,
    pub websocket: Option<ScriptWebSocketResponse>,
    pub status: u16,
    pub status_text: String,
    pub time_ms: u64,
    pub size_bytes: usize,
    pub url: String,
    pub headers: Vec<ScriptHeader>,
    /// Text body; None for binary responses.
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptVariable {
    pub name: String,
    pub value: String,
}

/// Runner iteration (spec 0073). Outside runner: index zero, count one, no data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptIteration {
    pub index: u32,
    pub count: u32,
    /// Values from this iteration data-file row.
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
    /// Request collection variables; None without a containing saved collection.
    pub collection: Option<Vec<ScriptVariable>>,
    /// Direct parent folder variables; None outside a folder.
    pub folder: Option<Vec<ScriptVariable>>,
    /// Request-local variables preserved between phases.
    pub local: Vec<ScriptVariable>,
    /// Ephemeral variables shared by the current runner/flow.
    pub runtime: Vec<ScriptVariable>,
    pub iteration: ScriptIteration,
    /// npm packages the host downloaded for this script's `require('npm:…')`
    /// calls (spec 0128); empty when it requires none.
    pub packages: Arc<ScriptPackages>,
}

/// Named script tests pass when callbacks do not throw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptTestResult {
    pub name: String,
    pub passed: bool,
    /// Mensagem da falha (ex.: de um `al.expect`); `None` quando passou.
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptOutput {
    /// Request after execution; unchanged by post-response scripts.
    pub request: ScriptRequest,
    /// Ambiente completo depois do script.
    pub environment: Vec<ScriptVariable>,
    /// Names written by al.environment.set, in order.
    pub changed_variables: Vec<String>,
    pub removed_variables: Vec<String>,
    /// Collection values after execution; None without a collection.
    pub collection: Option<Vec<ScriptVariable>>,
    /// Nomes gravados por `al.collection.set`, em ordem.
    pub changed_collection: Vec<String>,
    pub removed_collection: Vec<String>,
    /// Folder values after execution; None without a folder.
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

/// Globals `require` and `crypto.getRandomValues` (spec 0128), on top of the
/// natives in `packages`. Bundled libraries are evaluated as CommonJS modules
/// the first time they are required; npm packages as ES modules. Either way
/// the result is cached for the rest of the run.
const REQUIRE_PRELUDE: &str = r#"
var crypto = {
  getRandomValues: function (array) {
    if (!array || typeof array.byteLength !== 'number' || array instanceof Float32Array || array instanceof Float64Array) {
      throw new TypeError('crypto.getRandomValues espera um array de inteiros tipado');
    }
    var bytes = __randomBytes(array.byteLength);
    var view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (var i = 0; i < bytes.length; i++) view[i] = bytes[i];
    return array;
  }
};
var require = (function () {
  var cache = {};
  return function require(name) {
    name = String(name);
    if (Object.prototype.hasOwnProperty.call(cache, name)) return cache[name];
    var exported;
    if (name.indexOf('npm:') === 0) {
      exported = __requireNpm(name.slice(4).trim());
    } else {
      var source = __bundledSource(name);
      if (source === undefined) {
        throw new Error("módulo '" + name + "' não encontrado; disponíveis: lodash, crypto-js, moment, uuid ou 'npm:<pacote>@<versão>'");
      }
      var module = { exports: {} };
      var factory = (0, eval)('(function (module, exports) {\n' + source + '\n})');
      factory.call(module.exports, module, module.exports);
      exported = module.exports;
    }
    cache[name] = exported;
    return exported;
  };
})();
"#;

/// Pure JavaScript prelude constructing al over injected JSON host values; no I/O.
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
  // Postman passes headers and query params as one { key, value } object.
  var keyed = function (name, value) {
    return name !== null && typeof name === 'object' ? [name.key, name.value] : [name, value];
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
      set: function (name, value) { guard(); var pair=keyed(name, value); name=pair[0]; value=pair[1]; this.remove(name); var hash=''; var hashAt=request.url.indexOf('#'); if(hashAt>=0){hash=request.url.slice(hashAt);request.url=request.url.slice(0,hashAt);} request.url += (request.url.indexOf('?')>=0?'&':'?')+encodeURIComponent(String(name))+'='+encodeURIComponent(String(value)); request.url+=hash; },
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
        var pair = keyed(name, value);
        var i = headerIndex(pair[0]);
        if (i < 0) request.headers.push({ name: String(pair[0]), value: String(pair[1]) });
        else request.headers[i].value = String(pair[1]);
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
  if (request.grpc) {
    requestApi.grpc = {
      get service() { return request.grpc.service; },
      set service(v) { guard(); request.grpc.service = String(v); },
      get method() { return request.grpc.method; },
      set method(v) { guard(); request.grpc.method = String(v); },
      get message() { return JSON.parse(request.body); },
      set message(v) { guard(); request.body = JSON.stringify(v); },
      metadata: requestApi.headers
    };
  }
  if (request.websocket) {
    requestApi.websocket = {
      get subprotocols() { return request.websocket.subprotocols.slice(); },
      set subprotocols(v) {
        guard();
        request.websocket.subprotocols = (Array.isArray(v) ? v : [v]).map(function (item) { return String(item); });
      },
      get message() { return request.body; },
      set message(v) { guard(); request.body = typeof v === 'string' ? v : JSON.stringify(v); }
    };
  }
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
      // Parse anew on each call so scripts can mutate their copy without affecting later json() results.
      json: function () { return JSON.parse(this.text()); }
    };
  }
  if (responseApi && host.response.grpc) responseApi.grpc = host.response.grpc;
  if (responseApi && host.response.websocket) responseApi.websocket = host.response.websocket;
  // Null vars means missing scope: get returns undefined, set throws.
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
    matchers.equals = matchers.toBe; matchers.eqls = matchers.toEqual;
    matchers.contain = matchers.contains = matchers.includes = matchers.toContain;
    matchers.greaterThan = matchers.gt = matchers.toBeGreaterThan;
    matchers.lessThan = matchers.lt = matchers.toBeLessThan;
    matchers.least = matchers.gte = function (n) { check(actual >= n, 'esperado no mínimo ' + show(n) + got(), 'esperado menor que ' + show(n) + got()); };
    matchers.most = matchers.lte = function (n) { check(actual <= n, 'esperado no máximo ' + show(n) + got(), 'esperado maior que ' + show(n) + got()); };
    // Every matcher returns the chain, as in `.to.be.an('array').that.is.not.empty`.
    Object.keys(matchers).forEach(function (key) {
      var matcher = matchers[key];
      matchers[key] = function () { matcher.apply(matchers, arguments); return matchers; };
    });
    matchers.deep = { equal: matchers.toEqual, equals: matchers.toEqual, eql: matchers.toEqual, include: matchers.toContain, contain: matchers.toContain };
    ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'does', 'still', 'also'].forEach(function (word) { matchers[word] = matchers; });
    // Reading these properties is the assertion, so they must not resolve to undefined and pass.
    var state = function (name, pass, expected) {
      Object.defineProperty(matchers, name, { get: function () {
        check(pass(), 'esperado ' + expected + got(), 'esperado diferente de ' + expected);
        return matchers;
      } });
    };
    state('true', function () { return actual === true; }, 'true');
    state('false', function () { return actual === false; }, 'false');
    state('null', function () { return actual === null; }, 'null');
    state('undefined', function () { return actual === undefined; }, 'undefined');
    state('NaN', function () { return actual !== actual; }, 'NaN');
    state('ok', function () { return !!actual; }, 'valor verdadeiro');
    state('exist', function () { return actual !== null && actual !== undefined; }, 'valor existente');
    state('empty', function () {
      if (actual === null || actual === undefined) return false;
      return (typeof actual === 'string' || Array.isArray(actual) ? actual.length : Object.keys(actual).length) === 0;
    }, 'valor vazio');
    if (!negated) matchers.not = makeExpect(actual, true);
    return matchers;
  };
  var makeResponseAssertions = function (negated) {
    var check = function (pass, message) {
      if (pass === negated) throw assertionError((negated ? 'não esperado ' : 'esperado ') + message);
    };
    var assertions = {
      status: function (expected) {
        var actual = typeof expected === 'number' ? responseApi.status : responseApi.statusText;
        check(actual === expected, 'status ' + show(expected) + ', recebido ' + show(actual));
      },
      header: function (name, value) {
        var actual = responseApi.headers.get(name);
        var pass = actual !== undefined && (arguments.length < 2 || actual === String(value));
        check(pass, 'cabeçalho ' + show(name) + (arguments.length < 2 ? '' : ' igual a ' + show(value)) + ', recebido ' + show(actual));
      },
      body: function (expected) {
        var actual = responseApi.body;
        var pass = arguments.length === 0 ? !!actual : expected instanceof RegExp ? expected.test(String(actual)) : actual === expected;
        check(pass, 'corpo ' + (arguments.length === 0 ? 'preenchido' : show(expected)) + ', recebido ' + show(actual));
      },
      jsonBody: function (path, value) {
        var parsed = responseApi.json();
        if (arguments.length === 0) return;
        var result = readPath(parsed, path);
        var pass = result.found && (arguments.length < 2 || deepEqual(result.value, value));
        check(pass, 'JSON com ' + show(path) + (arguments.length < 2 ? '' : ' igual a ' + show(value)));
      }
    };
    var statusRanges = { info: [100, 199], success: [200, 299], redirection: [300, 399], clientError: [400, 499], serverError: [500, 599], error: [400, 599], ok: [200, 200], accepted: [202, 202], badRequest: [400, 400], unauthorized: [401, 401], forbidden: [403, 403], notFound: [404, 404], rateLimited: [429, 429] };
    Object.keys(statusRanges).forEach(function (name) {
      Object.defineProperty(assertions, name, { get: function () {
        var range = statusRanges[name];
        check(responseApi.status >= range[0] && responseApi.status <= range[1], 'resposta ' + name + ', recebido status ' + responseApi.status);
        return assertions;
      } });
    });
    Object.defineProperty(assertions, 'withBody', { get: function () { check(!!responseApi.body, 'resposta com corpo'); return assertions; } });
    Object.defineProperty(assertions, 'json', { get: function () { responseApi.json(); return assertions; } });
    assertions.to = assertions.be = assertions.have = assertions;
    if (!negated) assertions.not = makeResponseAssertions(true);
    return assertions;
  };
  if (responseApi) responseApi.to = makeResponseAssertions(false);
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
  api.require = require;
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

/// Runs a script on its own thread, with a native stack large enough for
/// the interpreter (see [`SCRIPT_THREAD_STACK_BYTES`]), and waits for it.
pub fn run_script(
    phase: ScriptPhase,
    source: &str,
    input: &ScriptInput,
) -> Result<ScriptOutput, ScriptError> {
    let fail = |message: String| ScriptError {
        phase,
        message,
        line: None,
    };
    std::thread::scope(|scope| {
        std::thread::Builder::new()
            .name("alcy-script".to_string())
            .stack_size(SCRIPT_THREAD_STACK_BYTES)
            .spawn_scoped(scope, || execute(phase, source, input))
            .map_err(|error| fail(format!("falha ao iniciar o script: {error}")))?
            .join()
            .unwrap_or_else(|_| Err(fail("o script terminou inesperadamente".to_string())))
    })
}

fn execute(
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

    let loader = Rc::new(packages::PackageLoader::new(input.packages.clone()));
    let mut context = Context::builder()
        .module_loader(loader.clone())
        .build()
        .map_err(|error| fail(error.to_string(), None))?;
    let _active_loader = packages::ActiveLoader::set(loader);
    packages::register_natives(&mut context)
        .map_err(|error| fail(describe(&error, &mut context), None))?;
    context
        .runtime_limits_mut()
        .set_loop_iteration_limit(LOOP_ITERATION_LIMIT);
    context
        .runtime_limits_mut()
        .set_recursion_limit(RECURSION_LIMIT);
    context
        .runtime_limits_mut()
        .set_stack_size_limit(STACK_SIZE_LIMIT);

    // Body bytes bound context JSON from below. Reject oversized bodies before constructing a context that multiplies memory use only to reject it afterward.
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
        .eval(Source::from_bytes(REQUIRE_PRELUDE))
        .map_err(|error| fail(describe(&error, &mut context), None))?;
    context
        .eval(Source::from_bytes(PRELUDE))
        .map_err(|error| fail(describe(&error, &mut context), None))?;

    // Evaluate user source separately from prelude so errors refer to user code.
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

/// The received WebSocket messages, from the body the executor writes: the
/// message itself when there is one, a JSON array when there are several
/// (each element parsed when it is JSON, a string otherwise).
fn received_messages(body: Option<&str>, received: u32) -> Vec<serde_json::Value> {
    let Some(body) = body else { return Vec::new() };
    let parsed = |text: &str| {
        serde_json::from_str::<serde_json::Value>(text)
            .unwrap_or_else(|_| serde_json::Value::String(text.to_string()))
    };
    match received {
        0 => Vec::new(),
        1 => vec![parsed(body)],
        _ => match serde_json::from_str::<serde_json::Value>(body) {
            Ok(serde_json::Value::Array(messages)) => messages,
            _ => vec![parsed(body)],
        },
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
            "grpc": r.grpc.as_ref().map(|grpc| {
                let messages = match r.body.as_deref().and_then(|body| serde_json::from_str::<Value>(body).ok()) {
                    Some(Value::Array(messages)) => messages,
                    Some(message) => vec![message],
                    None => vec![],
                };
                json!({ "code": grpc.code, "codeName": grpc.code_name,
                    "message": grpc.message, "trailers": headers(&grpc.trailers), "messages": messages })
            }),
            "websocket": r.websocket.as_ref().map(|websocket| {
                json!({ "closeCode": websocket.close_code, "closeReason": websocket.close_reason,
                    "closedBy": websocket.closed_by, "subprotocol": websocket.subprotocol,
                    "sent": websocket.sent, "received": websocket.received,
                    "messages": received_messages(r.body.as_deref(), websocket.received) })
            }),
        })
    });
    let mut iteration_data = Map::new();
    for variable in &input.iteration.data {
        iteration_data.insert(variable.name.clone(), Value::String(variable.value.clone()));
    }
    json!({
        "phase": phase.as_str(),
        "request": {
            "grpc": input.request.grpc.as_ref().map(|grpc| json!({ "service": grpc.service, "method": grpc.method })),
            "websocket": input.request.websocket.as_ref().map(|websocket| json!({ "subprotocols": websocket.subprotocols })),
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
            grpc: match request.get("grpc")? {
                serde_json::Value::Null => None,
                grpc => Some(ScriptGrpcRequest {
                    service: grpc.get("service")?.as_str()?.to_string(),
                    method: grpc.get("method")?.as_str()?.to_string(),
                }),
            },
            websocket: match request.get("websocket") {
                None | Some(serde_json::Value::Null) => None,
                Some(websocket) => Some(ScriptWebSocketRequest {
                    subprotocols: websocket
                        .get("subprotocols")?
                        .as_array()?
                        .iter()
                        .map(|item| item.as_str().map(str::to_string))
                        .collect::<Option<Vec<_>>>()?,
                }),
            },
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
                grpc: None,
                websocket: None,
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
            packages: Arc::default(),
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
            grpc: None,
            websocket: None,
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
    fn grpc_request_aliases_share_body_and_metadata_and_guard_post_response_edits() {
        let mut input = with_response(Some(r#"[{"message":"one"},{"message":"two"}]"#));
        input.request.grpc = Some(ScriptGrpcRequest {
            service: "test.Greeter".to_string(),
            method: "SayHello".to_string(),
        });
        input.response.as_mut().unwrap().grpc = Some(ScriptGrpcResponse {
            code: 5,
            code_name: "NOT_FOUND".to_string(),
            message: "missing".to_string(),
            trailers: vec![ScriptHeader {
                name: "x-final".to_string(),
                value: "yes".to_string(),
            }],
        });
        let output = run_script(ScriptPhase::PreRequest,
            "al.request.grpc.method = 'LotsOfReplies'; al.request.grpc.message = {name:'Ana'}; al.request.grpc.metadata.set('x-rpc', 'yes'); al.expect(al.request.json().name).toBe('Ana');", &input).unwrap();
        assert_eq!(output.request.grpc.unwrap().method, "LotsOfReplies");
        assert_eq!(output.request.body, r#"{"name":"Ana"}"#);
        assert!(
            output
                .request
                .headers
                .iter()
                .any(|header| header.name == "x-rpc" && header.value == "yes")
        );
        let output = run_script(ScriptPhase::PostResponse,
            "al.expect(al.response.grpc.code).toBe(5); al.environment.set('last', al.response.grpc.messages[1].message); al.expect(al.response.grpc.trailers[0].value).toBe('yes');", &input).unwrap();
        assert!(output.environment.contains(&ScriptVariable {
            name: "last".to_string(),
            value: "two".to_string()
        }));
        for source in [
            "al.request.grpc.service = 'changed'",
            "al.request.grpc.method = 'changed'",
            "al.request.grpc.message = {}",
            "al.request.grpc.metadata.set('x', 'y')",
        ] {
            assert!(
                run_script(ScriptPhase::PostResponse, source, &input)
                    .unwrap_err()
                    .message
                    .contains("somente leitura")
            );
        }
    }

    #[test]
    fn websocket_request_and_response_are_exposed_to_scripts() {
        let mut input = with_response(Some("[\n{\"op\":\"ack\"},\n\"plain text\"\n]"));
        input.request.websocket = Some(ScriptWebSocketRequest {
            subprotocols: vec!["chat".to_string()],
        });
        input.response.as_mut().unwrap().websocket = Some(ScriptWebSocketResponse {
            close_code: Some(1000),
            close_reason: String::new(),
            closed_by: "client".to_string(),
            subprotocol: Some("chat".to_string()),
            sent: 1,
            received: 2,
        });

        let output = run_script(
            ScriptPhase::PreRequest,
            "al.request.websocket.subprotocols = ['chat.v2', 'chat']; \
             al.request.websocket.message = {op: 'join'};",
            &input,
        )
        .unwrap();
        assert_eq!(
            output.request.websocket.unwrap().subprotocols,
            vec!["chat.v2".to_string(), "chat".to_string()]
        );
        assert_eq!(output.request.body, r#"{"op":"join"}"#);

        let output = run_script(
            ScriptPhase::PostResponse,
            "al.expect(al.response.websocket.closeCode).toBe(1000); \
             al.expect(al.response.websocket.received).toBe(2); \
             al.environment.set('first', al.response.websocket.messages[0].op); \
             al.environment.set('second', al.response.websocket.messages[1]);",
            &input,
        )
        .unwrap();
        assert!(output.environment.contains(&vars(&[("first", "ack")])[0]));
        assert!(
            output
                .environment
                .contains(&vars(&[("second", "plain text")])[0])
        );
        assert!(
            run_script(
                ScriptPhase::PostResponse,
                "al.request.websocket.subprotocols = []",
                &input
            )
            .unwrap_err()
            .message
            .contains("somente leitura")
        );
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

    fn assertion_outcomes(assertions: &[&str]) -> Vec<bool> {
        let script = assertions
            .iter()
            .map(|body| format!("al.test('t', function () {{ {body}; }});"))
            .collect::<Vec<_>>()
            .join("\n");
        let context = with_response(Some("{\"ok\":true,\"items\":[]}"));
        outcomes(
            &run_script(ScriptPhase::PostResponse, &script, &context)
                .unwrap()
                .tests,
        )
    }

    #[test]
    fn property_assertions_fail_instead_of_passing_silently() {
        assert_eq!(
            assertion_outcomes(&[
                "al.expect(false).to.be.true",
                "al.expect(true).to.be.false",
                "al.expect(1).to.be.null",
                "al.expect(1).to.be.undefined",
                "al.expect(0).to.be.ok",
                "al.expect(null).to.exist",
                "al.expect('a').to.be.empty",
            ]),
            vec![false; 7]
        );
        assert_eq!(
            assertion_outcomes(&[
                "al.expect(true).to.be.true",
                "al.expect(false).to.not.be.true",
                "al.expect(null).to.be.null",
                "al.expect(1).to.exist",
                "al.expect([]).to.be.empty",
                "al.expect({a:1}).to.not.be.empty",
            ]),
            vec![true; 6]
        );
    }

    #[test]
    fn chained_and_comparison_assertions_follow_the_postman_forms() {
        assert_eq!(
            assertion_outcomes(&[
                "al.expect(5).to.be.at.least(5)",
                "al.expect(5).to.be.at.most(5)",
                "al.expect(5).to.be.greaterThan(1).and.lessThan(9)",
                "al.expect({a:[1]}).to.deep.equal({a:[1]})",
                "al.expect([1]).to.be.an('array').that.is.not.empty",
            ]),
            vec![true; 5]
        );
        assert_eq!(
            assertion_outcomes(&["al.expect(1).to.be.at.least(2)"]),
            vec![false]
        );
    }

    #[test]
    fn response_assertions_check_status_headers_and_body() {
        assert_eq!(
            assertion_outcomes(&[
                "al.response.to.have.status(201)",
                "al.response.to.have.status('Created')",
                "al.response.to.be.success",
                "al.response.to.not.be.error",
                "al.response.to.not.have.header('X-Missing')",
                "al.response.to.have.jsonBody('ok', true)",
                "al.response.to.be.json",
                "al.response.to.be.withBody",
            ]),
            vec![true; 8]
        );
        assert_eq!(
            assertion_outcomes(&[
                "al.response.to.have.status(200)",
                "al.response.to.be.ok",
                "al.response.to.be.notFound",
                "al.response.to.have.header('X-Missing')",
                "al.response.to.have.jsonBody('missing')",
            ]),
            vec![false; 5]
        );
    }

    #[test]
    fn headers_and_query_accept_postman_key_value_objects() {
        let out = run_script(
            ScriptPhase::PreRequest,
            "al.request.headers.set({key:'accept',value:'text/plain'});
             al.request.headers.set({key:'X-New',value:1});
             al.request.query.set({key:'page',value:'2'});",
            &input(),
        )
        .unwrap();
        assert_eq!(out.request.headers[0].value, "text/plain");
        assert_eq!(out.request.headers[1].name, "X-New");
        assert_eq!(out.request.headers[1].value, "1");
        assert!(out.request.url.ends_with("?page=2"));
    }

    /// Runs `source` and returns what it logged.
    fn logs_of(source: &str, input: &ScriptInput) -> Vec<String> {
        run_script(ScriptPhase::PreRequest, source, input)
            .unwrap_or_else(|error| panic!("{}", error.message))
            .logs
    }

    #[test]
    fn requires_the_bundled_libraries() {
        let logs = logs_of(
            r#"
            var _ = require('lodash');
            var CryptoJS = require('crypto-js');
            var moment = require('moment');
            var uuid = require('uuid');
            al.console.log(JSON.stringify(_.chunk([1, 2, 3], 2)));
            al.console.log(CryptoJS.SHA256('abc').toString());
            al.console.log(CryptoJS.enc.Base64.stringify(CryptoJS.HmacSHA256('msg', 'key')));
            al.console.log(moment.utc('2024-01-02T03:04:05Z').format('YYYY/MM/DD HH:mm'));
            al.console.log(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid.v4()));
            al.console.log(CryptoJS.lib.WordArray.random(16).sigBytes);
            "#,
            &input(),
        );
        assert_eq!(
            logs,
            vec![
                "[[1,2],[3]]",
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                // Reference: `printf msg | openssl dgst -sha256 -hmac key -binary | base64`.
                "LZPLwb4We8sWN6SiPL/wGnh48MUO6DOVTqUiG7G4xig=",
                "2024/01/02 03:04",
                "true",
                "16",
            ]
        );
    }

    #[test]
    fn caches_a_required_module_and_exposes_al_require() {
        let logs = logs_of(
            "al.console.log(require('lodash') === al.require('lodash'));",
            &input(),
        );
        assert_eq!(logs, vec!["true"]);
    }

    #[test]
    fn rejects_an_unknown_module_with_the_available_ones() {
        let error =
            run_script(ScriptPhase::PreRequest, "require('cheerio')", &input()).unwrap_err();
        assert!(
            error.message.contains("'cheerio' não encontrado"),
            "{}",
            error.message
        );
        assert!(error.message.contains("npm:"), "{}", error.message);
    }

    #[test]
    fn get_random_values_fills_typed_arrays() {
        let logs = logs_of(
            r#"
            var bytes = crypto.getRandomValues(new Uint8Array(64));
            var nonZero = 0; for (var i = 0; i < bytes.length; i++) if (bytes[i] !== 0) nonZero++;
            al.console.log(nonZero > 32);
            al.console.log(crypto.getRandomValues(new Uint32Array(2)).length);
            try { crypto.getRandomValues(new Uint8Array(70000)); } catch (e) { al.console.log(e instanceof RangeError); }
            "#,
            &input(),
        );
        assert_eq!(logs, vec!["true", "2", "true"]);
    }

    fn with_packages(entries: &[(&str, &str)], modules: &[(&str, &str)]) -> ScriptInput {
        let mut input = input();
        input.packages = Arc::new(ScriptPackages {
            entries: entries
                .iter()
                .map(|(name, path)| (name.to_string(), path.to_string()))
                .collect(),
            modules: modules
                .iter()
                .map(|(path, source)| (path.to_string(), source.to_string()))
                .collect(),
        });
        input
    }

    #[test]
    fn requires_an_npm_package_with_its_imports() {
        let input = with_packages(
            &[("greet@1.0.0", "/greet@1.0.0/es2022/greet.bundle.mjs")],
            &[
                (
                    "/greet@1.0.0/es2022/greet.bundle.mjs",
                    "import { prefix } from \"/node/prefix.mjs\"; import { suffix } from \"./suffix.mjs\"; \
                     export default function greet(name) { return prefix + name + suffix; }",
                ),
                ("/node/prefix.mjs", "export const prefix = 'hi ';"),
                (
                    "/greet@1.0.0/es2022/suffix.mjs",
                    "export const suffix = '!';",
                ),
            ],
        );
        let logs = logs_of(
            "var greet = require('npm:greet@1.0.0'); al.console.log(greet('ana')); \
             al.console.log(al.require('npm:greet@1.0.0') === greet);",
            &input,
        );
        assert_eq!(logs, vec!["hi ana!", "true"]);
    }

    #[test]
    fn an_npm_package_without_default_export_returns_its_namespace() {
        let input = with_packages(
            &[("consts@2.0.0", "/consts.mjs")],
            &[(
                "/consts.mjs",
                "export const answer = 42; export function twice(n) { return n * 2; }",
            )],
        );
        let logs = logs_of(
            "var c = require('npm:consts@2.0.0'); al.console.log(c.twice(c.answer));",
            &input,
        );
        assert_eq!(logs, vec!["84"]);
    }

    #[test]
    fn reports_npm_packages_that_were_not_downloaded_or_fail() {
        let error = run_script(
            ScriptPhase::PreRequest,
            "require('npm:missing@1.0.0')",
            &input(),
        )
        .unwrap_err();
        assert!(
            error.message.contains("não disponível: missing@1.0.0"),
            "{}",
            error.message
        );

        let input = with_packages(
            &[("broken@1.0.0", "/broken.mjs")],
            &[(
                "/broken.mjs",
                "import { x } from \"/absent.mjs\"; export default x;",
            )],
        );
        let error = run_script(
            ScriptPhase::PreRequest,
            "require('npm:broken@1.0.0')",
            &input,
        )
        .unwrap_err();
        assert!(error.message.contains("/absent.mjs"), "{}", error.message);

        let input = with_packages(
            &[("throws@1.0.0", "/throws.mjs")],
            &[("/throws.mjs", "throw new Error('boom'); export default 1;")],
        );
        let error = run_script(
            ScriptPhase::PreRequest,
            "require('npm:throws@1.0.0')",
            &input,
        )
        .unwrap_err();
        assert!(error.message.contains("boom"), "{}", error.message);
    }

    #[test]
    fn finds_literal_npm_requests() {
        let source = r#"
            const dayjs = require('npm:dayjs@1.11.13');
            const again = al.require( "npm:dayjs@1.11.13" );
            const scoped = pm.require(`npm:@scope/pkg@2.0.0`);
            const local = require('lodash');
            const dynamic = require('npm:' + name);
            const template = require(`npm:${name}`);
        "#;
        assert_eq!(
            npm_requests(source),
            vec!["dayjs@1.11.13", "@scope/pkg@2.0.0"]
        );
    }

    #[test]
    fn resolves_esm_sh_specifiers() {
        let referrer = std::path::Path::new("/pkg@1.0.0/es2022/pkg.mjs");
        assert_eq!(
            resolve_specifier("/node/buffer.mjs", Some(referrer)).as_deref(),
            Some("/node/buffer.mjs")
        );
        assert_eq!(
            resolve_specifier("https://esm.sh/node/util.mjs", None).as_deref(),
            Some("/node/util.mjs")
        );
        assert_eq!(
            resolve_specifier("./chunk.mjs", Some(referrer)).as_deref(),
            Some("/pkg@1.0.0/es2022/chunk.mjs")
        );
        assert_eq!(
            resolve_specifier("../../other.mjs", Some(referrer)).as_deref(),
            Some("/other.mjs")
        );
        assert_eq!(resolve_specifier("lodash", Some(referrer)), None);
        assert_eq!(resolve_specifier("https://evil.example/x.mjs", None), None);
    }
}
