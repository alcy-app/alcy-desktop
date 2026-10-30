use std::borrow::Cow;
use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alcy_domain::{
    Authentication, BodyEncoding, BodyPayload, Endpoint, FormDataField, FormDataFieldValue,
    HeaderEntry, HistoryEntry, HistoryFailureKind, HistoryOutcome, HttpMethod, ProtocolId,
    RawBodyLanguage, Request, RequestDocument, Response, ResponseHeader, ResponseMetadata,
    UrlEncodedField,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::collections_store::{
    PersistedGrpcCall, grpc_from_persisted, persisted_from_grpc, protocol_from_str, protocol_to_str,
};
use crate::storage_error::StorageError;

const CURRENT_MANIFEST_VERSION: u32 = 2;
const CURRENT_DETAIL_VERSION: u32 = 1;
const MANIFEST_FILE_NAME: &str = "alcy-history.json";
const DETAIL_DIR_NAME: &str = "alcy-history";

/// Tamanho máximo do corpo de resposta gravado no detalhe de uma entrada.
/// O histórico é uma referência do que voltou, não um arquivo de downloads:
/// sem este teto, reenviar um endpoint que devolve dezenas de MB deixaria
/// uma cópia inteira por envio no workspace durante toda a retenção. Acima
/// dele, um corpo de texto é cortado (em fronteira de caractere) e um corpo
/// binário (base64) não é gravado — um prefixo de imagem não serve para
/// nada —, e a entrada fica marcada com `body_truncated`.
pub const MAX_PERSISTED_RESPONSE_BODY_BYTES: usize = 5 * 1024 * 1024;

/// Serializa as escritas do índice (`alcy-history.json`) dentro do
/// processo. `record` e `set_baseline` fazem ler → alterar → regravar o
/// índice inteiro; duas gravações concorrentes (envios em paralelo, cada
/// uma num `spawn_blocking`) sem este lock perdiam entradas — a segunda
/// regravava o índice lido antes de a primeira terminar.
static INDEX_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Sufixo único por escrita para o arquivo temporário de `write_atomic`:
/// mesmo com o lock acima, duas instâncias do app no mesmo workspace não
/// podem disputar o mesmo `.tmp`.
static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Resumo leve de uma entrada do histórico — o que `alcy-history.json`
/// guarda e o que basta para listar (`list_history`). Nunca carrega
/// corpo/headers de requisição nem de resposta; só `HistoryStore::load_entry`
/// lê o arquivo de detalhe correspondente.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistorySummary {
    pub id: String,
    pub protocol: ProtocolId,
    pub endpoint: String,
    pub executed_at: SystemTime,
    pub outcome: HistorySummaryOutcome,
    /// `None` em entradas gravadas antes de o método ir para o índice.
    pub method: Option<HttpMethod>,
    pub request_id: Option<String>,
    pub tab_id: Option<String>,
    /// Envio marcado como baseline da sua requisição (ADR 0036); não é
    /// podado pela retenção enquanto estiver marcado.
    pub baseline: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HistorySummaryOutcome {
    Success {
        status_code: u16,
        duration_ms: u64,
        size_bytes: usize,
        /// `true` quando "Salvar respostas" estava desligado e só o resumo
        /// (status, tempo e tamanho) foi guardado.
        response_omitted: bool,
    },
    Failed {
        kind: HistoryFailureKind,
    },
}

#[derive(Serialize, Deserialize, Clone)]
struct PersistedManifest {
    version: u32,
    entries: Vec<PersistedIndexEntry>,
}

/// Mesmo formato de `PersistedManifest`, emprestando as entradas — gravar
/// o índice não precisa cloná-lo inteiro.
#[derive(Serialize)]
struct PersistedManifestRef<'a> {
    version: u32,
    entries: &'a [PersistedIndexEntry],
}

#[derive(Serialize, Deserialize, Clone)]
struct PersistedIndexEntry {
    id: String,
    protocol: String,
    endpoint: String,
    executed_at_ms: u64,
    outcome: PersistedOutcomeSummary,
    // Aditivos (ADR 0036): entradas gravadas antes não têm esses campos e
    // ficam fora do histórico de envios de qualquer requisição.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    baseline: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PersistedOutcomeSummary {
    Success {
        status_code: u16,
        duration_ms: u64,
        size_bytes: usize,
        /// Aditivo: `true` quando só o resumo da resposta foi guardado.
        /// Entradas antigas não têm o campo e continuam valendo como
        /// respostas guardadas.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        response_omitted: bool,
    },
    Failed {
        kind: String,
    },
}

/// `body`s em `Cow`: ao gravar, o detalhe empresta os corpos da entrada em
/// vez de cloná-los (um corpo de resposta pode ter vários MB); ao ler, o
/// serde os desserializa como `Cow::Owned`.
#[derive(Serialize, Deserialize)]
struct PersistedDetail<'a> {
    version: u32,
    body: Cow<'a, str>,
    variables: String,
    headers: Vec<PersistedHeader>,
    authentication: PersistedAuthentication,
    outcome: PersistedOutcomeDetail<'a>,
    #[serde(default = "default_persisted_method")]
    method: String,
    /// Aditivo (tipos de corpo REST) — entradas gravadas antes desta
    /// mudança sempre tratavam `body` como texto "raw".
    #[serde(default = "default_persisted_body_type")]
    body_type: String,
    #[serde(default = "default_persisted_raw_language")]
    raw_body_language: String,
    #[serde(default)]
    form_data: Vec<PersistedFormDataField>,
    #[serde(default)]
    url_encoded: Vec<PersistedUrlEncodedField>,
    #[serde(default)]
    binary_file_path: String,
    /// Additive (spec 0129): only gRPC sends write it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    grpc: Option<PersistedGrpcCall>,
}

fn default_persisted_method() -> String {
    "post".to_string()
}

fn default_persisted_body_type() -> String {
    "raw".to_string()
}

fn default_persisted_raw_language() -> String {
    "json".to_string()
}

#[derive(Serialize, Deserialize)]
struct PersistedUrlEncodedField {
    name: String,
    value: String,
    enabled: bool,
}

#[derive(Serialize, Deserialize)]
struct PersistedFormDataField {
    name: String,
    enabled: bool,
    value: PersistedFormDataFieldValue,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PersistedFormDataFieldValue {
    Text { value: String },
    File { file_path: String },
}

#[derive(Serialize, Deserialize)]
struct PersistedHeader {
    name: String,
    value: String,
    enabled: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PersistedAuthentication {
    None,
    Inherit,
    CustomHeader {
        name: String,
        value: String,
    },
    Bearer {
        token: String,
    },
    Basic {
        username: String,
        password: String,
    },
    Digest {
        username: String,
        password: String,
    },
    OAuth2ClientCredentials {
        client_id: String,
        client_secret: String,
        token_url: String,
        scope: String,
    },
}

#[derive(Serialize, Deserialize)]
struct PersistedResponseHeader {
    name: String,
    value: String,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PersistedOutcomeDetail<'a> {
    Success {
        body: Cow<'a, str>,
        /// Aditivo: `true` quando o corpo passou de
        /// `MAX_PERSISTED_RESPONSE_BODY_BYTES` e não foi gravado inteiro.
        /// Entradas antigas não têm o campo e sempre guardavam o corpo todo.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        body_truncated: bool,
        headers: Vec<PersistedResponseHeader>,
        // Aditivo (spec 0036/ADR 0009), mesmo padrão de `method` em
        // `PersistedDetail`: entradas gravadas antes desta mudança não têm
        // este campo e desserializam como `"text"` — a única possibilidade
        // para elas, já que binário não existia ainda.
        #[serde(default = "default_persisted_encoding")]
        encoding: String,
        /// Aditivo: `true` quando só o resumo da resposta foi guardado (sem
        /// corpo nem headers), porque "Salvar respostas" estava desligado.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        response_omitted: bool,
    },
    Failed {
        message: String,
    },
}

fn default_persisted_encoding() -> String {
    "text".to_string()
}

// Formato anterior (versão 1): uma entrada completa (requisição + resposta
// inteiras) por elemento, tudo num único arquivo. Mantido só para migração
// automática no primeiro `load` após o upgrade — nunca mais escrito.
#[derive(Deserialize)]
struct PersistedManifestV1 {
    entries: Vec<PersistedHistoryEntryV1>,
}

#[derive(Deserialize)]
struct PersistedHistoryEntryV1 {
    id: String,
    protocol: String,
    endpoint: String,
    body: String,
    variables: String,
    headers: Vec<PersistedHeader>,
    authentication: PersistedAuthentication,
    executed_at_ms: u64,
    outcome: PersistedOutcomeV1,
    #[serde(default = "default_persisted_method")]
    method: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PersistedOutcomeV1 {
    Success {
        status_code: u16,
        duration_ms: u64,
        body: String,
        headers: Vec<PersistedResponseHeader>,
    },
    Failed {
        kind: String,
        message: String,
    },
}

/// Lê e grava o histórico de execuções de um workspace, com escrita
/// atômica (arquivo temporário + rename) e formato versionado.
///
/// Índice e detalhe ficam separados:
/// `alcy-history.json` guarda só um resumo por entrada (barato de ler e
/// reescrever a cada execução); `alcy-history/<id>.json` guarda o corpo e
/// os headers de cada entrada, escrito uma única vez e lido apenas quando
/// aquela entrada específica é aberta.
///
/// A retenção é um parâmetro do chamador, não uma constante interna: os
/// commands passam a retenção configurada na aba "Geral".
pub struct HistoryStore {
    manifest_path: PathBuf,
    detail_dir: PathBuf,
    retention: Duration,
}

impl HistoryStore {
    pub fn new(root: PathBuf, retention: Duration) -> Self {
        Self {
            manifest_path: root.join(MANIFEST_FILE_NAME),
            detail_dir: root.join(DETAIL_DIR_NAME),
            retention,
        }
    }

    /// Lista o resumo de cada entrada, mais recente primeiro — sem tocar
    /// em nenhum arquivo de detalhe.
    pub fn load_summaries(&self) -> Result<Vec<HistorySummary>, StorageError> {
        self.load_index()?
            .into_iter()
            .map(summary_from_index)
            .collect()
    }

    /// Busca uma entrada completa (requisição + resposta inteiras) pelo
    /// `id`, juntando o resumo do índice com o arquivo de detalhe
    /// correspondente. `Ok(None)` quando `id` não está no índice.
    pub fn load_entry(&self, id: &str) -> Result<Option<HistoryEntry>, StorageError> {
        let index = self.load_index()?;
        let Some(index_entry) = index.into_iter().find(|entry| entry.id == id) else {
            return Ok(None);
        };

        let detail = self.read_detail(id)?;
        entry_from_parts(index_entry, detail).map(Some)
    }

    /// Envios de uma requisição, mais recente primeiro: as entradas cujo
    /// `request_id` bate com o da requisição salva ou cujo `tab_id` bate com
    /// o da aba — um rascunho salvo depois continua enxergando os envios
    /// feitos antes de ganhar `request_id`.
    pub fn load_sends(
        &self,
        request_id: Option<&str>,
        tab_id: Option<&str>,
    ) -> Result<Vec<HistorySummary>, StorageError> {
        self.load_index()?
            .into_iter()
            .filter(|entry| belongs_to(entry, request_id, tab_id))
            .map(summary_from_index)
            .collect()
    }

    /// Marca `id` como baseline dos envios da requisição, desmarcando o
    /// anterior; com `id = None`, só desmarca. Um `id` que não pertence à
    /// requisição falha com `NotFound`, sem alterar nada.
    pub fn set_baseline(
        &self,
        request_id: Option<&str>,
        tab_id: Option<&str>,
        id: Option<&str>,
    ) -> Result<(), StorageError> {
        let _guard = lock_index_writes();
        let mut index = self.load_index()?;
        if let Some(id) = id {
            let found = index
                .iter()
                .any(|entry| entry.id == id && belongs_to(entry, request_id, tab_id));
            if !found {
                return Err(StorageError::NotFound(format!(
                    "envio não encontrado no histórico: {id}"
                )));
            }
        }

        for entry in index
            .iter_mut()
            .filter(|entry| belongs_to(entry, request_id, tab_id))
        {
            entry.baseline = Some(entry.id.as_str()) == id;
        }

        self.write_manifest(&index)
    }

    /// Registra `entry` como a execução mais recente: grava seu detalhe,
    /// insere o resumo no início do índice, remove entradas mais antigas
    /// que `retention` (índice e arquivo de detalhe) e persiste o índice.
    /// Entradas marcadas como baseline não são podadas.
    pub fn record(&self, entry: HistoryEntry) -> Result<(), StorageError> {
        // O detalhe tem nome próprio (`<id>.json`) e não disputa nada com
        // outras gravações: escrevê-lo fora do lock mantém o trecho
        // serializado curto mesmo para um corpo grande.
        self.write_detail(&entry)?;

        let _guard = lock_index_writes();
        let mut index = self.load_index()?;

        index.insert(0, index_entry_from_entry(&entry));
        self.write_retained(index, true)
    }

    /// Remove as entradas mais antigas que `retention` sem gravar nada novo
    /// — é o que faz uma retenção reduzida (ou o histórico desativado) valer
    /// para o que já estava em disco. Sem nada a podar, não reescreve o índice.
    pub fn prune(&self) -> Result<(), StorageError> {
        let _guard = lock_index_writes();
        let index = self.load_index()?;
        self.write_retained(index, false)
    }

    /// Grava no índice só as entradas dentro da retenção (e as marcadas como
    /// baseline) e remove o detalhe das podadas. Com `always_write = false`,
    /// não reescreve o índice quando nada foi podado.
    fn write_retained(
        &self,
        index: Vec<PersistedIndexEntry>,
        always_write: bool,
    ) -> Result<(), StorageError> {
        let now = SystemTime::now();
        let (kept, pruned): (Vec<_>, Vec<_>) = index.into_iter().partition(|index_entry| {
            let executed_at = UNIX_EPOCH + Duration::from_millis(index_entry.executed_at_ms);
            index_entry.baseline
                || now.duration_since(executed_at).unwrap_or(Duration::ZERO) <= self.retention
        });
        if !always_write && pruned.is_empty() {
            return Ok(());
        }

        self.write_manifest(&kept)?;
        for pruned_entry in &pruned {
            self.remove_detail(&pruned_entry.id);
        }

        Ok(())
    }

    fn load_index(&self) -> Result<Vec<PersistedIndexEntry>, StorageError> {
        if !self.manifest_path.exists() {
            return Ok(Vec::new());
        }

        let raw = fs::read_to_string(&self.manifest_path)
            .map_err(|error| StorageError::Read(error.to_string()))?;
        let value: Value = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;
        let version = value
            .get("version")
            .and_then(Value::as_u64)
            .ok_or_else(|| StorageError::Corrupted("campo version ausente".to_string()))?
            as u32;

        match version {
            CURRENT_MANIFEST_VERSION => {
                let manifest: PersistedManifest = serde_json::from_value(value)
                    .map_err(|error| StorageError::Corrupted(error.to_string()))?;
                Ok(manifest.entries)
            }
            1 => self.migrate_from_v1(value),
            other => Err(StorageError::UnsupportedVersion(other)),
        }
    }

    /// Decompõe um manifesto na versão 1 (entradas completas embutidas)
    /// em índice + arquivos de detalhe, grava o resultado já na versão 2
    /// e devolve o índice migrado.
    fn migrate_from_v1(&self, value: Value) -> Result<Vec<PersistedIndexEntry>, StorageError> {
        let legacy: PersistedManifestV1 = serde_json::from_value(value)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;
        let entries = legacy
            .entries
            .into_iter()
            .map(entry_from_v1)
            .collect::<Result<Vec<_>, StorageError>>()?;

        let index: Vec<PersistedIndexEntry> = entries.iter().map(index_entry_from_entry).collect();
        for entry in &entries {
            self.write_detail(entry)?;
        }
        self.write_manifest(&index)?;

        Ok(index)
    }

    fn write_manifest(&self, index: &[PersistedIndexEntry]) -> Result<(), StorageError> {
        let manifest = PersistedManifestRef {
            version: CURRENT_MANIFEST_VERSION,
            entries: index,
        };

        write_atomic_json(&self.manifest_path, &manifest)
    }

    fn detail_path(&self, id: &str) -> PathBuf {
        self.detail_dir.join(format!("{id}.json"))
    }

    fn read_detail(&self, id: &str) -> Result<PersistedDetail<'static>, StorageError> {
        let path = self.detail_path(id);
        let raw = fs::read_to_string(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                StorageError::NotFound(format!("detalhe do histórico não encontrado: {id}"))
            } else {
                StorageError::Read(error.to_string())
            }
        })?;
        let detail: PersistedDetail = serde_json::from_str(&raw)
            .map_err(|error| StorageError::Corrupted(error.to_string()))?;

        if detail.version != CURRENT_DETAIL_VERSION {
            return Err(StorageError::UnsupportedVersion(detail.version));
        }

        Ok(detail)
    }

    fn write_detail(&self, entry: &HistoryEntry) -> Result<(), StorageError> {
        let detail = detail_from_entry(entry);
        write_atomic_json(&self.detail_path(&entry.id), &detail)
    }

    /// Remove o arquivo de detalhe de uma entrada podada por retenção.
    /// Best-effort: a entrada já saiu do índice, então um arquivo órfão
    /// que sobreviva a uma falha aqui nunca mais é referenciado.
    fn remove_detail(&self, id: &str) {
        let _ = fs::remove_file(self.detail_path(id));
    }
}

/// Sem nenhuma das duas chaves, nada pertence — evita casar entradas
/// antigas (sem origem) com uma consulta vazia.
fn belongs_to(entry: &PersistedIndexEntry, request_id: Option<&str>, tab_id: Option<&str>) -> bool {
    let matches = |stored: &Option<String>, wanted: Option<&str>| {
        wanted.is_some() && stored.as_deref() == wanted
    };
    matches(&entry.request_id, request_id) || matches(&entry.tab_id, tab_id)
}

fn lock_index_writes() -> std::sync::MutexGuard<'static, ()> {
    INDEX_WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Serializa `value` direto no arquivo temporário (sem montar a `String`
/// JSON inteira em memória antes) e o renomeia sobre `path`.
fn write_atomic_json<T: Serialize>(path: &Path, value: &T) -> Result<(), StorageError> {
    let write_error = |error: std::io::Error| StorageError::Write(error.to_string());
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(write_error)?;
    }

    let tmp_path = path.with_extension(format!(
        "{}-{}.tmp",
        std::process::id(),
        TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let file = fs::File::create(&tmp_path).map_err(write_error)?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer(&mut writer, value)
            .map_err(|error| StorageError::Write(error.to_string()))?;
        writer.flush().map_err(write_error)?;
        fs::rename(&tmp_path, path).map_err(write_error)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    result
}

/// Corta `body` para caber em `MAX_PERSISTED_RESPONSE_BODY_BYTES`. Texto
/// vira o maior prefixo em fronteira de caractere; base64 acima do teto não
/// é gravado (um prefixo não decodifica para nada útil). O `bool` diz se
/// houve corte.
fn persisted_response_body(body: &str, encoding: BodyEncoding) -> (Cow<'_, str>, bool) {
    if body.len() <= MAX_PERSISTED_RESPONSE_BODY_BYTES {
        return (Cow::Borrowed(body), false);
    }
    match encoding {
        BodyEncoding::Base64 => (Cow::Borrowed(""), true),
        BodyEncoding::Text => {
            let mut end = MAX_PERSISTED_RESPONSE_BODY_BYTES;
            while !body.is_char_boundary(end) {
                end -= 1;
            }
            (Cow::Borrowed(&body[..end]), true)
        }
    }
}

fn method_to_str(method: HttpMethod) -> &'static str {
    match method {
        HttpMethod::Get => "get",
        HttpMethod::Post => "post",
        HttpMethod::Put => "put",
        HttpMethod::Patch => "patch",
        HttpMethod::Delete => "delete",
        HttpMethod::Head => "head",
        HttpMethod::Options => "options",
    }
}

fn method_from_str(value: &str) -> Result<HttpMethod, StorageError> {
    match value {
        "get" => Ok(HttpMethod::Get),
        "post" => Ok(HttpMethod::Post),
        "put" => Ok(HttpMethod::Put),
        "patch" => Ok(HttpMethod::Patch),
        "delete" => Ok(HttpMethod::Delete),
        "head" => Ok(HttpMethod::Head),
        "options" => Ok(HttpMethod::Options),
        other => Err(StorageError::Corrupted(format!(
            "método HTTP desconhecido: {other}"
        ))),
    }
}

fn failure_kind_to_str(kind: HistoryFailureKind) -> &'static str {
    match kind {
        HistoryFailureKind::Network => "network",
        HistoryFailureKind::Timeout => "timeout",
    }
}

fn failure_kind_from_str(value: &str) -> Result<HistoryFailureKind, StorageError> {
    match value {
        "network" => Ok(HistoryFailureKind::Network),
        "timeout" => Ok(HistoryFailureKind::Timeout),
        other => Err(StorageError::Corrupted(format!(
            "tipo de falha de histórico desconhecido: {other}"
        ))),
    }
}

fn authentication_from_persisted(persisted: PersistedAuthentication) -> Authentication {
    match persisted {
        PersistedAuthentication::None => Authentication::None,
        PersistedAuthentication::Inherit => Authentication::Inherit,
        PersistedAuthentication::CustomHeader { name, value } => {
            Authentication::CustomHeader { name, value }
        }
        PersistedAuthentication::Bearer { token } => Authentication::Bearer { token },
        PersistedAuthentication::Basic { username, password } => {
            Authentication::Basic { username, password }
        }
        PersistedAuthentication::Digest { username, password } => {
            Authentication::Digest { username, password }
        }
        PersistedAuthentication::OAuth2ClientCredentials {
            client_id,
            client_secret,
            token_url,
            scope,
        } => Authentication::OAuth2ClientCredentials {
            client_id,
            client_secret,
            token_url,
            scope,
        },
    }
}

fn persisted_from_authentication(authentication: &Authentication) -> PersistedAuthentication {
    match authentication {
        Authentication::None => PersistedAuthentication::None,
        Authentication::Inherit => PersistedAuthentication::Inherit,
        Authentication::CustomHeader { name, value } => PersistedAuthentication::CustomHeader {
            name: name.clone(),
            value: value.clone(),
        },
        Authentication::Bearer { token } => PersistedAuthentication::Bearer {
            token: token.clone(),
        },
        Authentication::Basic { username, password } => PersistedAuthentication::Basic {
            username: username.clone(),
            password: password.clone(),
        },
        Authentication::Digest { username, password } => PersistedAuthentication::Digest {
            username: username.clone(),
            password: password.clone(),
        },
        Authentication::OAuth2ClientCredentials {
            client_id,
            client_secret,
            token_url,
            scope,
        } => PersistedAuthentication::OAuth2ClientCredentials {
            client_id: client_id.clone(),
            client_secret: client_secret.clone(),
            token_url: token_url.clone(),
            scope: scope.clone(),
        },
    }
}

fn raw_language_to_str(language: RawBodyLanguage) -> &'static str {
    match language {
        RawBodyLanguage::Text => "text",
        RawBodyLanguage::JavaScript => "javascript",
        RawBodyLanguage::Json => "json",
        RawBodyLanguage::Html => "html",
        RawBodyLanguage::Xml => "xml",
    }
}

fn raw_language_from_str(value: &str) -> Result<RawBodyLanguage, StorageError> {
    match value {
        "text" => Ok(RawBodyLanguage::Text),
        "javascript" => Ok(RawBodyLanguage::JavaScript),
        "json" => Ok(RawBodyLanguage::Json),
        "html" => Ok(RawBodyLanguage::Html),
        "xml" => Ok(RawBodyLanguage::Xml),
        other => Err(StorageError::Corrupted(format!(
            "linguagem de corpo raw desconhecida: {other}"
        ))),
    }
}

fn form_data_field_from_persisted(persisted: &PersistedFormDataField) -> FormDataField {
    FormDataField {
        name: persisted.name.clone(),
        enabled: persisted.enabled,
        value: match &persisted.value {
            PersistedFormDataFieldValue::Text { value } => FormDataFieldValue::Text(value.clone()),
            PersistedFormDataFieldValue::File { file_path } => FormDataFieldValue::File {
                file_path: file_path.clone(),
            },
        },
    }
}

fn persisted_from_form_data_field(field: &FormDataField) -> PersistedFormDataField {
    PersistedFormDataField {
        name: field.name.clone(),
        enabled: field.enabled,
        value: match &field.value {
            FormDataFieldValue::Text(value) => PersistedFormDataFieldValue::Text {
                value: value.clone(),
            },
            FormDataFieldValue::File { file_path } => PersistedFormDataFieldValue::File {
                file_path: file_path.clone(),
            },
        },
    }
}

fn body_payload_from_persisted(
    persisted: &PersistedDetail<'_>,
) -> Result<BodyPayload, StorageError> {
    match persisted.body_type.as_str() {
        "none" => Ok(BodyPayload::None),
        "raw" => Ok(BodyPayload::Raw {
            language: raw_language_from_str(&persisted.raw_body_language)?,
        }),
        "urlencoded" => Ok(BodyPayload::UrlEncoded(
            persisted
                .url_encoded
                .iter()
                .map(|field| UrlEncodedField {
                    name: field.name.clone(),
                    value: field.value.clone(),
                    enabled: field.enabled,
                })
                .collect(),
        )),
        "formData" => Ok(BodyPayload::FormData(
            persisted
                .form_data
                .iter()
                .map(form_data_field_from_persisted)
                .collect(),
        )),
        "binary" => Ok(BodyPayload::Binary {
            file_path: persisted.binary_file_path.clone(),
        }),
        other => Err(StorageError::Corrupted(format!(
            "tipo de corpo desconhecido: {other}"
        ))),
    }
}

struct PersistedBodyFields {
    body_type: String,
    raw_body_language: String,
    form_data: Vec<PersistedFormDataField>,
    url_encoded: Vec<PersistedUrlEncodedField>,
    binary_file_path: String,
}

fn persisted_from_body_payload(payload: &BodyPayload) -> PersistedBodyFields {
    let empty = PersistedBodyFields {
        body_type: String::new(),
        raw_body_language: default_persisted_raw_language(),
        form_data: Vec::new(),
        url_encoded: Vec::new(),
        binary_file_path: String::new(),
    };

    match payload {
        BodyPayload::None => PersistedBodyFields {
            body_type: "none".to_string(),
            ..empty
        },
        BodyPayload::Raw { language } => PersistedBodyFields {
            body_type: "raw".to_string(),
            raw_body_language: raw_language_to_str(*language).to_string(),
            ..empty
        },
        BodyPayload::UrlEncoded(fields) => PersistedBodyFields {
            body_type: "urlencoded".to_string(),
            url_encoded: fields
                .iter()
                .map(|field| PersistedUrlEncodedField {
                    name: field.name.clone(),
                    value: field.value.clone(),
                    enabled: field.enabled,
                })
                .collect(),
            ..empty
        },
        BodyPayload::FormData(fields) => PersistedBodyFields {
            body_type: "formData".to_string(),
            form_data: fields.iter().map(persisted_from_form_data_field).collect(),
            ..empty
        },
        BodyPayload::Binary { file_path } => PersistedBodyFields {
            body_type: "binary".to_string(),
            binary_file_path: file_path.clone(),
            ..empty
        },
    }
}

fn headers_from_persisted(
    persisted: Vec<PersistedHeader>,
) -> Result<Vec<HeaderEntry>, StorageError> {
    persisted
        .into_iter()
        .map(|header| {
            HeaderEntry::new(header.name, header.value, header.enabled)
                .map_err(|error| StorageError::Corrupted(error.to_string()))
        })
        .collect()
}

fn persisted_from_headers(headers: &[HeaderEntry]) -> Vec<PersistedHeader> {
    headers
        .iter()
        .map(|header| PersistedHeader {
            name: header.name().to_string(),
            value: header.value().to_string(),
            enabled: header.enabled,
        })
        .collect()
}

fn summary_from_index(index: PersistedIndexEntry) -> Result<HistorySummary, StorageError> {
    let protocol = protocol_from_str(&index.protocol)?;
    let outcome = match index.outcome {
        PersistedOutcomeSummary::Success {
            status_code,
            duration_ms,
            size_bytes,
            response_omitted,
        } => HistorySummaryOutcome::Success {
            status_code,
            duration_ms,
            size_bytes,
            response_omitted,
        },
        PersistedOutcomeSummary::Failed { kind } => HistorySummaryOutcome::Failed {
            kind: failure_kind_from_str(&kind)?,
        },
    };

    Ok(HistorySummary {
        id: index.id,
        protocol,
        endpoint: index.endpoint,
        executed_at: UNIX_EPOCH + Duration::from_millis(index.executed_at_ms),
        outcome,
        method: index.method.as_deref().map(method_from_str).transpose()?,
        request_id: index.request_id,
        tab_id: index.tab_id,
        baseline: index.baseline,
    })
}

fn index_entry_from_entry(entry: &HistoryEntry) -> PersistedIndexEntry {
    let outcome = match &entry.outcome {
        HistoryOutcome::Success(response) => PersistedOutcomeSummary::Success {
            status_code: response.status_code,
            duration_ms: response.duration_ms,
            size_bytes: response.size_bytes,
            response_omitted: entry.response_omitted,
        },
        HistoryOutcome::Failed { kind, .. } => PersistedOutcomeSummary::Failed {
            kind: failure_kind_to_str(*kind).to_string(),
        },
    };

    let executed_at_ms = entry
        .executed_at
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64;

    PersistedIndexEntry {
        id: entry.id.clone(),
        protocol: protocol_to_str(entry.request.document.protocol).to_string(),
        endpoint: entry.request.endpoint.url().to_string(),
        executed_at_ms,
        outcome,
        method: Some(method_to_str(entry.request.method).to_string()),
        request_id: entry.request_id.clone(),
        tab_id: entry.tab_id.clone(),
        baseline: false,
    }
}

fn detail_from_entry(entry: &HistoryEntry) -> PersistedDetail<'_> {
    let outcome = match &entry.outcome {
        HistoryOutcome::Success(response) => {
            let (body, body_truncated) = persisted_response_body(&response.body, response.encoding);
            PersistedOutcomeDetail::Success {
                body,
                body_truncated,
                headers: response
                    .headers
                    .iter()
                    .map(|header| PersistedResponseHeader {
                        name: header.name.clone(),
                        value: header.value.clone(),
                    })
                    .collect(),
                encoding: match response.encoding {
                    BodyEncoding::Text => "text",
                    BodyEncoding::Base64 => "base64",
                }
                .to_string(),
                response_omitted: entry.response_omitted,
            }
        }
        HistoryOutcome::Failed { message, .. } => PersistedOutcomeDetail::Failed {
            message: message.clone(),
        },
    };

    let body_fields = persisted_from_body_payload(&entry.request.body_payload);

    PersistedDetail {
        version: CURRENT_DETAIL_VERSION,
        body: Cow::Borrowed(&entry.request.document.body),
        variables: entry.request.variables.clone(),
        headers: persisted_from_headers(&entry.request.headers),
        authentication: persisted_from_authentication(&entry.request.authentication),
        outcome,
        method: method_to_str(entry.request.method).to_string(),
        body_type: body_fields.body_type,
        raw_body_language: body_fields.raw_body_language,
        form_data: body_fields.form_data,
        url_encoded: body_fields.url_encoded,
        binary_file_path: body_fields.binary_file_path,
        grpc: (entry.request.document.protocol == ProtocolId::Grpc)
            .then(|| persisted_from_grpc(&entry.request.grpc)),
    }
}

fn entry_from_parts(
    index: PersistedIndexEntry,
    detail: PersistedDetail<'static>,
) -> Result<HistoryEntry, StorageError> {
    let body_payload = body_payload_from_persisted(&detail)?;
    let protocol = protocol_from_str(&index.protocol)?;
    let endpoint = Endpoint::new(index.endpoint)
        .map_err(|error| StorageError::Corrupted(error.to_string()))?;
    let document = RequestDocument::new(protocol, detail.body.into_owned());
    let headers = headers_from_persisted(detail.headers)?;
    let authentication = authentication_from_persisted(detail.authentication);
    let method = method_from_str(&detail.method)?;

    let request = Request::new(
        endpoint,
        document,
        detail.variables,
        headers,
        authentication,
    )
    .with_method(method)
    .with_body_payload(body_payload)
    .with_grpc(detail.grpc.map(grpc_from_persisted).unwrap_or_default());

    let mut response_body_truncated = false;
    let mut response_omitted = false;
    let outcome = match (index.outcome, detail.outcome) {
        (
            PersistedOutcomeSummary::Success {
                status_code,
                duration_ms,
                size_bytes,
                ..
            },
            PersistedOutcomeDetail::Success {
                body,
                body_truncated,
                headers,
                encoding,
                response_omitted: omitted,
            },
        ) => {
            response_body_truncated = body_truncated;
            response_omitted = omitted;
            let body = body.into_owned();
            let headers = headers
                .into_iter()
                .map(|header| ResponseHeader {
                    name: header.name,
                    value: header.value,
                })
                .collect();
            // Headers efetivos de requisição, cookies, timing e conexão não
            // são persistidos (fora do escopo do ADR 0010) — uma entrada
            // recarregada do histórico volta sempre com metadata vazia.
            let mut response = if encoding == "base64" {
                Response::new_binary(
                    status_code,
                    duration_ms,
                    size_bytes,
                    body,
                    headers,
                    ResponseMetadata::default(),
                )
            } else {
                Response::new(
                    status_code,
                    duration_ms,
                    body,
                    headers,
                    ResponseMetadata::default(),
                )
            };
            if omitted {
                // Sem corpo guardado, o tamanho vem do índice.
                response.size_bytes = size_bytes;
            }
            HistoryOutcome::Success(response)
        }
        (PersistedOutcomeSummary::Failed { kind }, PersistedOutcomeDetail::Failed { message }) => {
            HistoryOutcome::Failed {
                kind: failure_kind_from_str(&kind)?,
                message,
            }
        }
        _ => {
            return Err(StorageError::Corrupted(format!(
                "índice e detalhe do histórico divergem em outcome para {}",
                index.id
            )));
        }
    };

    let executed_at = UNIX_EPOCH + Duration::from_millis(index.executed_at_ms);
    let mut entry = HistoryEntry::new(index.id, request, outcome, executed_at)
        .with_source(index.request_id, index.tab_id);
    entry.response_body_truncated = response_body_truncated;
    entry.response_omitted = response_omitted;
    Ok(entry)
}

fn entry_from_v1(persisted: PersistedHistoryEntryV1) -> Result<HistoryEntry, StorageError> {
    let protocol = protocol_from_str(&persisted.protocol)?;
    let endpoint = Endpoint::new(persisted.endpoint)
        .map_err(|error| StorageError::Corrupted(error.to_string()))?;
    let document = RequestDocument::new(protocol, persisted.body);
    let headers = headers_from_persisted(persisted.headers)?;
    let authentication = authentication_from_persisted(persisted.authentication);
    let method = method_from_str(&persisted.method)?;

    let request = Request::new(
        endpoint,
        document,
        persisted.variables,
        headers,
        authentication,
    )
    .with_method(method);

    let outcome = match persisted.outcome {
        PersistedOutcomeV1::Success {
            status_code,
            duration_ms,
            body,
            headers,
        } => HistoryOutcome::Success(Response::new(
            status_code,
            duration_ms,
            body,
            headers
                .into_iter()
                .map(|header| ResponseHeader {
                    name: header.name,
                    value: header.value,
                })
                .collect(),
            ResponseMetadata::default(),
        )),
        PersistedOutcomeV1::Failed { kind, message } => HistoryOutcome::Failed {
            kind: failure_kind_from_str(&kind)?,
            message,
        },
    };

    let executed_at = UNIX_EPOCH + Duration::from_millis(persisted.executed_at_ms);

    Ok(HistoryEntry::new(
        persisted.id,
        request,
        outcome,
        executed_at,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{GrpcCall, GrpcSchemaSource};

    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("alcy-history-store-test-{nanos}-{count}"))
    }

    fn week() -> Duration {
        Duration::from_secs(7 * 24 * 60 * 60)
    }

    /// O formato persistido só guarda milissegundos — usado nos testes de
    /// round-trip para que a entrada original já nasça na precisão que
    /// sobrevive a uma volta pelo disco.
    fn millis_now() -> SystemTime {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        UNIX_EPOCH + Duration::from_millis(millis)
    }

    fn sample_request() -> Request {
        Request::new(
            Endpoint::new("https://api.example.com/graphql").unwrap(),
            RequestDocument::new(ProtocolId::GraphQl, "query { ping }"),
            "{}",
            vec![HeaderEntry::new("Accept", "application/json", true).unwrap()],
            Authentication::Bearer {
                token: "secret".to_string(),
            },
        )
    }

    fn success_entry(id: &str, executed_at: SystemTime) -> HistoryEntry {
        let response = Response::new(
            200,
            12,
            "{\"data\":{\"ping\":true}}",
            vec![ResponseHeader {
                name: "Content-Type".to_string(),
                value: "application/json".to_string(),
            }],
            ResponseMetadata::default(),
        );
        HistoryEntry::new(
            id,
            sample_request(),
            HistoryOutcome::Success(response),
            executed_at,
        )
    }

    fn entry_with_response_body(id: &str, body: String, encoding: BodyEncoding) -> HistoryEntry {
        let response = match encoding {
            BodyEncoding::Text => {
                Response::new(200, 1, body, Vec::new(), ResponseMetadata::default())
            }
            BodyEncoding::Base64 => {
                let size = body.len();
                Response::new_binary(200, 1, size, body, Vec::new(), ResponseMetadata::default())
            }
        };
        HistoryEntry::new(
            id,
            sample_request(),
            HistoryOutcome::Success(response),
            millis_now(),
        )
    }

    fn loaded_body(store: &HistoryStore, id: &str) -> (String, bool) {
        let entry = store.load_entry(id).unwrap().unwrap();
        let HistoryOutcome::Success(response) = entry.outcome else {
            panic!("esperava sucesso");
        };
        (response.body, entry.response_body_truncated)
    }

    #[test]
    fn keeps_a_body_within_the_limit_whole_and_not_truncated() {
        let store = HistoryStore::new(temp_root(), week());
        store
            .record(entry_with_response_body(
                "small",
                "{\"ok\":true}".to_string(),
                BodyEncoding::Text,
            ))
            .unwrap();

        assert_eq!(
            loaded_body(&store, "small"),
            ("{\"ok\":true}".to_string(), false)
        );
    }

    #[test]
    fn truncates_a_text_body_over_the_limit_at_a_char_boundary() {
        let store = HistoryStore::new(temp_root(), week());
        // "é" ocupa 2 bytes: com um prefixo de 1 byte, o limite cai no meio
        // de um caractere e precisa recuar.
        let body = format!("x{}", "é".repeat(MAX_PERSISTED_RESPONSE_BODY_BYTES));
        store
            .record(entry_with_response_body("big", body, BodyEncoding::Text))
            .unwrap();

        let (stored, truncated) = loaded_body(&store, "big");
        assert!(truncated);
        assert!(stored.len() <= MAX_PERSISTED_RESPONSE_BODY_BYTES);
        assert!(stored.len() >= MAX_PERSISTED_RESPONSE_BODY_BYTES - 1);
        assert!(stored.starts_with("xé"));
    }

    #[test]
    fn drops_a_binary_body_over_the_limit() {
        let store = HistoryStore::new(temp_root(), week());
        let body = "A".repeat(MAX_PERSISTED_RESPONSE_BODY_BYTES + 4);
        store
            .record(entry_with_response_body(
                "image",
                body,
                BodyEncoding::Base64,
            ))
            .unwrap();

        assert_eq!(loaded_body(&store, "image"), (String::new(), true));
    }

    #[test]
    fn reads_a_detail_written_before_body_truncated_existed_as_not_truncated() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());
        store
            .record(entry_with_response_body(
                "old",
                "{}".to_string(),
                BodyEncoding::Text,
            ))
            .unwrap();
        let detail_path = root.join(DETAIL_DIR_NAME).join("old.json");
        let raw = fs::read_to_string(&detail_path).unwrap();
        assert!(!raw.contains("body_truncated") && !raw.contains("bodyTruncated"));

        assert_eq!(loaded_body(&store, "old"), ("{}".to_string(), false));
    }

    #[test]
    fn concurrent_records_keep_every_entry_in_the_index() {
        let root = temp_root();
        let handles: Vec<_> = (0..16)
            .map(|index| {
                let root = root.clone();
                std::thread::spawn(move || {
                    let store = HistoryStore::new(root, week());
                    store
                        .record(success_entry(&format!("entry-{index}"), millis_now()))
                        .unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        let summaries = HistoryStore::new(root.clone(), week())
            .load_summaries()
            .unwrap();
        assert_eq!(summaries.len(), 16);
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn load_summaries_returns_an_empty_list_when_the_manifest_does_not_exist() {
        let store = HistoryStore::new(temp_root(), week());

        assert!(store.load_summaries().unwrap().is_empty());
    }

    #[test]
    fn record_then_load_entry_round_trips_a_successful_entry_with_its_response_body() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());
        let entry = success_entry("entry-1", millis_now());

        store.record(entry.clone()).unwrap();
        let loaded = store.load_entry("entry-1").unwrap();

        assert_eq!(loaded, Some(entry));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn record_round_trips_a_network_failure() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());
        let entry = HistoryEntry::new(
            "entry-1",
            sample_request(),
            HistoryOutcome::Failed {
                kind: HistoryFailureKind::Network,
                message: "connection refused".to_string(),
            },
            millis_now(),
        );

        store.record(entry.clone()).unwrap();
        let loaded = store.load_entry("entry-1").unwrap();

        assert_eq!(loaded, Some(entry));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_summaries_never_carries_the_response_body() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());
        store
            .record(success_entry("entry-1", millis_now()))
            .unwrap();

        let raw = fs::read_to_string(root.join(MANIFEST_FILE_NAME)).unwrap();

        assert!(
            !raw.contains("ping"),
            "índice não deveria conter o corpo da resposta: {raw}"
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_entry_returns_none_for_an_unknown_id() {
        let store = HistoryStore::new(temp_root(), week());

        assert_eq!(store.load_entry("missing").unwrap(), None);
    }

    #[test]
    fn record_inserts_new_entries_first() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());

        store
            .record(success_entry("entry-1", SystemTime::now()))
            .unwrap();
        store
            .record(success_entry("entry-2", SystemTime::now()))
            .unwrap();

        let entries = store.load_summaries().unwrap();

        assert_eq!(entries[0].id, "entry-2");
        assert_eq!(entries[1].id, "entry-1");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn record_prunes_entries_older_than_the_retention_window() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), Duration::from_secs(60));
        let old_entry = success_entry("entry-old", SystemTime::now() - Duration::from_secs(120));

        store.record(old_entry).unwrap();
        store
            .record(success_entry("entry-new", SystemTime::now()))
            .unwrap();

        let entries = store.load_summaries().unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "entry-new");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn record_removes_the_detail_file_of_a_pruned_entry() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), Duration::from_secs(60));
        let old_entry = success_entry("entry-old", SystemTime::now() - Duration::from_secs(120));

        store.record(old_entry).unwrap();
        store
            .record(success_entry("entry-new", SystemTime::now()))
            .unwrap();

        assert!(!root.join(DETAIL_DIR_NAME).join("entry-old.json").exists());
        assert!(root.join(DETAIL_DIR_NAME).join("entry-new.json").exists());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn prune_applies_a_shorter_retention_to_existing_entries_but_keeps_baselines() {
        let root = temp_root();
        let seeding = HistoryStore::new(root.clone(), week());
        let old = SystemTime::now() - Duration::from_secs(120);
        seeding
            .record(
                success_entry("entry-baseline", old).with_source(Some("req-1".to_string()), None),
            )
            .unwrap();
        seeding.record(success_entry("entry-old", old)).unwrap();
        seeding
            .record(success_entry("entry-new", SystemTime::now()))
            .unwrap();
        seeding
            .set_baseline(Some("req-1"), None, Some("entry-baseline"))
            .unwrap();

        let store = HistoryStore::new(root.clone(), Duration::from_secs(60));
        store.prune().unwrap();

        let ids: Vec<String> = store
            .load_summaries()
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect();
        assert_eq!(ids, vec!["entry-new", "entry-baseline"]);
        assert!(!root.join(DETAIL_DIR_NAME).join("entry-old.json").exists());

        HistoryStore::new(root.clone(), Duration::ZERO)
            .prune()
            .unwrap();
        let ids: Vec<String> = store
            .load_summaries()
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect();
        assert_eq!(ids, vec!["entry-baseline"]);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_entry_without_response_details_roundtrips_its_summary_only() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());
        let entry = success_entry("entry-1", millis_now());
        let HistoryOutcome::Success(original) = &entry.outcome else {
            unreachable!()
        };
        let size_bytes = original.size_bytes;

        store.record(entry.without_response_details()).unwrap();

        let summary = store
            .load_summaries()
            .unwrap()
            .into_iter()
            .find(|summary| summary.id == "entry-1")
            .unwrap();
        assert_eq!(
            summary.outcome,
            HistorySummaryOutcome::Success {
                status_code: 200,
                duration_ms: 12,
                size_bytes,
                response_omitted: true,
            }
        );

        let loaded = store.load_entry("entry-1").unwrap().unwrap();
        assert!(loaded.response_omitted);
        let HistoryOutcome::Success(response) = loaded.outcome else {
            panic!("a entrada continua sendo um sucesso");
        };
        assert_eq!(response.status_code, 200);
        assert_eq!(response.size_bytes, size_bytes);
        assert!(response.body.is_empty() && response.headers.is_empty());
        let raw = fs::read_to_string(root.join(DETAIL_DIR_NAME).join("entry-1.json")).unwrap();
        assert!(!raw.contains(r#"\"ping\":true"#));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_entry_with_its_response_is_not_marked_as_omitted() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());
        store
            .record(success_entry("entry-1", millis_now()))
            .unwrap();

        assert!(
            !store
                .load_entry("entry-1")
                .unwrap()
                .unwrap()
                .response_omitted
        );
        let raw = fs::read_to_string(root.join(DETAIL_DIR_NAME).join("entry-1.json")).unwrap();
        assert!(!raw.contains("response_omitted"));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn prune_without_a_history_does_not_create_one() {
        let root = temp_root();
        HistoryStore::new(root.clone(), Duration::ZERO)
            .prune()
            .unwrap();
        assert!(!root.join(MANIFEST_FILE_NAME).exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_does_not_leave_a_temporary_file_behind() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());

        store
            .record(success_entry("entry-1", SystemTime::now()))
            .unwrap();

        assert!(!root.join(MANIFEST_FILE_NAME).with_extension("tmp").exists());
        assert!(
            !root
                .join(DETAIL_DIR_NAME)
                .join("entry-1")
                .with_extension("tmp")
                .exists()
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_fails_with_corrupted_for_invalid_json() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(MANIFEST_FILE_NAME), "not json").unwrap();
        let store = HistoryStore::new(root.clone(), week());

        let error = store.load_summaries().unwrap_err();

        assert!(matches!(error, StorageError::Corrupted(_)));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_fails_with_unsupported_version_for_a_future_version() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"version": 99, "entries": []}"#,
        )
        .unwrap();
        let store = HistoryStore::new(root.clone(), week());

        let error = store.load_summaries().unwrap_err();

        assert_eq!(
            error.to_string(),
            StorageError::UnsupportedVersion(99).to_string()
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_entry_fails_with_not_found_when_the_detail_file_is_missing() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());
        store
            .record(success_entry("entry-1", SystemTime::now()))
            .unwrap();
        fs::remove_file(root.join(DETAIL_DIR_NAME).join("entry-1.json")).unwrap();

        let error = store.load_entry("entry-1").unwrap_err();

        assert!(matches!(error, StorageError::NotFound(_)));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn migrates_a_v1_manifest_into_index_and_detail_files() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let v1_json = r#"{
            "version": 1,
            "entries": [{
                "id": "entry-1",
                "protocol": "graphql",
                "endpoint": "https://api.example.com/graphql",
                "body": "query { ping }",
                "variables": "{}",
                "headers": [{"name": "Accept", "value": "application/json", "enabled": true}],
                "authentication": {"type": "bearer", "token": "secret"},
                "executed_at_ms": 1700000000000,
                "outcome": {
                    "type": "success",
                    "status_code": 200,
                    "duration_ms": 12,
                    "body": "{\"data\":{\"ping\":true}}",
                    "headers": [{"name": "Content-Type", "value": "application/json"}]
                }
            }]
        }"#;
        fs::write(root.join(MANIFEST_FILE_NAME), v1_json).unwrap();
        let store = HistoryStore::new(root.clone(), week());

        let summaries = store.load_summaries().unwrap();

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "entry-1");
        assert_eq!(
            summaries[0].outcome,
            HistorySummaryOutcome::Success {
                status_code: 200,
                duration_ms: 12,
                size_bytes: "{\"data\":{\"ping\":true}}".len(),
                response_omitted: false,
            }
        );

        let detail = store.load_entry("entry-1").unwrap().unwrap();
        assert_eq!(detail.request.document.body, "query { ping }");
        assert_eq!(
            detail.request.method,
            HttpMethod::Post,
            "entradas v1 nunca tinham método — devem migrar como POST"
        );
        match detail.outcome {
            HistoryOutcome::Success(response) => {
                assert_eq!(response.body, "{\"data\":{\"ping\":true}}");
            }
            HistoryOutcome::Failed { .. } => panic!("esperava sucesso"),
        }

        let raw_manifest = fs::read_to_string(root.join(MANIFEST_FILE_NAME)).unwrap();
        assert!(raw_manifest.contains("\"version\":2"));
        assert!(root.join(DETAIL_DIR_NAME).join("entry-1.json").exists());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn record_then_load_entry_round_trips_a_rest_request_with_a_non_post_method() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());
        let request = Request::new(
            Endpoint::new("https://api.example.com/users").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        )
        .with_method(HttpMethod::Delete);
        let entry = HistoryEntry::new(
            "entry-1",
            request,
            HistoryOutcome::Success(Response::new(
                204,
                5,
                "",
                vec![],
                ResponseMetadata::default(),
            )),
            millis_now(),
        );

        store.record(entry.clone()).unwrap();
        let loaded = store.load_entry("entry-1").unwrap();

        assert_eq!(loaded, Some(entry));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn record_then_load_entry_round_trips_a_grpc_request() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());
        let request = Request::new(
            Endpoint::new("localhost:50051").unwrap(),
            RequestDocument::new(ProtocolId::Grpc, r#"{"name": "ana"}"#),
            "",
            vec![],
            Authentication::None,
        )
        .with_grpc(GrpcCall {
            service: "helloworld.Greeter".to_string(),
            method: "SayHello".to_string(),
            schema_source: GrpcSchemaSource::ProtoFiles {
                files: vec!["hello.proto".to_string()],
                import_paths: vec![],
            },
            deadline_ms: Some(1_000),
        });
        let entry = HistoryEntry::new(
            "entry-1",
            request,
            HistoryOutcome::Success(Response::new(
                200,
                5,
                r#"{"message": "hi ana"}"#,
                vec![],
                ResponseMetadata::default(),
            )),
            millis_now(),
        );

        store.record(entry.clone()).unwrap();

        assert_eq!(store.load_entry("entry-1").unwrap(), Some(entry));
        let summaries = store.load_summaries().unwrap();
        assert_eq!(summaries[0].protocol, ProtocolId::Grpc);
        fs::remove_dir_all(&root).ok();
    }

    /// ADR 0009 / spec 0036: um corpo binário (imagem) persistido precisa
    /// voltar como `BodyEncoding::Base64` com `size_bytes` decodificado, não
    /// `body.len()` (que mede o texto base64, ~33% maior).
    #[test]
    fn record_then_load_entry_round_trips_a_base64_encoded_response_body() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());
        let response =
            Response::new_binary(200, 12, 3, "YWJj", vec![], ResponseMetadata::default());
        let entry = HistoryEntry::new(
            "entry-1",
            sample_request(),
            HistoryOutcome::Success(response),
            millis_now(),
        );

        store.record(entry.clone()).unwrap();
        let loaded = store.load_entry("entry-1").unwrap();

        assert_eq!(loaded, Some(entry));

        fs::remove_dir_all(&root).ok();
    }

    /// Aditivo (mesmo padrão do teste de `method` logo abaixo): uma entrada
    /// gravada antes desta mudança não tem `outcome.encoding` no arquivo de
    /// detalhe — só podia ser texto, já que binário não existia ainda.
    #[test]
    fn load_entry_defaults_to_text_encoding_for_a_detail_file_without_an_encoding_field() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());
        store
            .record(success_entry("entry-1", millis_now()))
            .unwrap();
        let detail_path = root.join(DETAIL_DIR_NAME).join("entry-1.json");
        let raw = fs::read_to_string(&detail_path).unwrap();
        let mut value: Value = serde_json::from_str(&raw).unwrap();
        value
            .get_mut("outcome")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("encoding");
        fs::write(&detail_path, serde_json::to_string(&value).unwrap()).unwrap();

        let loaded = store.load_entry("entry-1").unwrap().unwrap();

        match loaded.outcome {
            HistoryOutcome::Success(response) => assert_eq!(response.encoding, BodyEncoding::Text),
            HistoryOutcome::Failed { .. } => panic!("expected a successful outcome"),
        }

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_entry_defaults_to_post_for_a_detail_file_without_a_method_field() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());
        store
            .record(success_entry("entry-1", millis_now()))
            .unwrap();
        let detail_path = root.join(DETAIL_DIR_NAME).join("entry-1.json");
        let raw = fs::read_to_string(&detail_path).unwrap();
        let mut value: Value = serde_json::from_str(&raw).unwrap();
        value.as_object_mut().unwrap().remove("method");
        fs::write(&detail_path, serde_json::to_string(&value).unwrap()).unwrap();

        let loaded = store.load_entry("entry-1").unwrap().unwrap();

        assert_eq!(loaded.request.method, HttpMethod::Post);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_entry_fails_with_corrupted_for_an_unknown_method() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());
        store
            .record(success_entry("entry-1", millis_now()))
            .unwrap();
        let detail_path = root.join(DETAIL_DIR_NAME).join("entry-1.json");
        let raw = fs::read_to_string(&detail_path).unwrap();
        let mut value: Value = serde_json::from_str(&raw).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("method".to_string(), Value::String("trace".to_string()));
        fs::write(&detail_path, serde_json::to_string(&value).unwrap()).unwrap();

        let error = store.load_entry("entry-1").unwrap_err();

        assert!(matches!(error, StorageError::Corrupted(_)));

        fs::remove_dir_all(&root).ok();
    }

    fn entry_with_body(
        id: &str,
        body_payload: BodyPayload,
        executed_at: SystemTime,
    ) -> HistoryEntry {
        let request = Request::new(
            Endpoint::new("https://api.example.com/users").unwrap(),
            RequestDocument::new(ProtocolId::Rest, ""),
            "",
            vec![],
            Authentication::None,
        )
        .with_body_payload(body_payload);
        HistoryEntry::new(
            id,
            request,
            HistoryOutcome::Success(Response::new(
                204,
                5,
                "",
                vec![],
                ResponseMetadata::default(),
            )),
            executed_at,
        )
    }

    #[test]
    fn record_then_load_entry_round_trips_every_body_type() {
        let bodies = vec![
            BodyPayload::None,
            BodyPayload::Raw {
                language: RawBodyLanguage::Xml,
            },
            BodyPayload::UrlEncoded(vec![UrlEncodedField {
                name: "a".to_string(),
                value: "1".to_string(),
                enabled: false,
            }]),
            BodyPayload::FormData(vec![FormDataField {
                name: "attachment".to_string(),
                enabled: true,
                value: FormDataFieldValue::File {
                    file_path: "/tmp/photo.png".to_string(),
                },
            }]),
            BodyPayload::Binary {
                file_path: "/tmp/archive.zip".to_string(),
            },
        ];

        for body in bodies {
            let root = temp_root();
            let store = HistoryStore::new(root.clone(), week());
            let entry = entry_with_body("entry-1", body.clone(), millis_now());

            store.record(entry.clone()).unwrap();
            let loaded = store.load_entry("entry-1").unwrap();

            assert_eq!(
                loaded.map(|loaded| loaded.request.body_payload),
                Some(body.clone()),
                "não fez round-trip: {body:?}"
            );

            fs::remove_dir_all(&root).ok();
        }
    }

    #[test]
    fn load_entry_defaults_to_raw_json_for_a_detail_file_without_a_body_type_field() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());
        store
            .record(success_entry("entry-1", millis_now()))
            .unwrap();
        let detail_path = root.join(DETAIL_DIR_NAME).join("entry-1.json");
        let raw = fs::read_to_string(&detail_path).unwrap();
        let mut value: Value = serde_json::from_str(&raw).unwrap();
        value.as_object_mut().unwrap().remove("body_type");
        fs::write(&detail_path, serde_json::to_string(&value).unwrap()).unwrap();

        let loaded = store.load_entry("entry-1").unwrap().unwrap();

        assert_eq!(
            loaded.request.body_payload,
            BodyPayload::Raw {
                language: RawBodyLanguage::Json
            }
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_entry_fails_with_corrupted_for_an_unknown_body_type() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());
        store
            .record(success_entry("entry-1", millis_now()))
            .unwrap();
        let detail_path = root.join(DETAIL_DIR_NAME).join("entry-1.json");
        let raw = fs::read_to_string(&detail_path).unwrap();
        let mut value: Value = serde_json::from_str(&raw).unwrap();
        value.as_object_mut().unwrap().insert(
            "body_type".to_string(),
            Value::String("graphql".to_string()),
        );
        fs::write(&detail_path, serde_json::to_string(&value).unwrap()).unwrap();

        let error = store.load_entry("entry-1").unwrap_err();

        assert!(matches!(error, StorageError::Corrupted(_)));

        fs::remove_dir_all(&root).ok();
    }

    fn send_entry(id: &str, request_id: Option<&str>, tab_id: Option<&str>) -> HistoryEntry {
        success_entry(id, millis_now())
            .with_source(request_id.map(str::to_string), tab_id.map(str::to_string))
    }

    #[test]
    fn record_then_load_entry_round_trips_the_source() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());
        let entry = send_entry("entry-1", Some("req-1"), Some("tab-1"));

        store.record(entry.clone()).unwrap();

        assert_eq!(store.load_entry("entry-1").unwrap(), Some(entry));
        let summary = &store.load_summaries().unwrap()[0];
        assert_eq!(summary.request_id.as_deref(), Some("req-1"));
        assert_eq!(summary.tab_id.as_deref(), Some("tab-1"));
        assert_eq!(summary.method, Some(HttpMethod::Post));
        assert!(!summary.baseline);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn loads_an_index_entry_written_without_the_send_history_fields() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());
        store
            .record(success_entry("entry-1", millis_now()))
            .unwrap();

        let raw = fs::read_to_string(root.join(MANIFEST_FILE_NAME)).unwrap();
        assert!(!raw.contains("requestId") && !raw.contains("request_id"));
        assert!(!raw.contains("baseline"));

        let summary = &store.load_summaries().unwrap()[0];
        assert_eq!(summary.request_id, None);
        assert_eq!(summary.tab_id, None);
        assert!(!summary.baseline);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_sends_matches_by_request_id_or_tab_id() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());
        store
            .record(success_entry("no-source", millis_now()))
            .unwrap();
        store
            .record(send_entry("draft", None, Some("tab-1")))
            .unwrap();
        store
            .record(send_entry("saved", Some("req-1"), Some("tab-1")))
            .unwrap();
        store
            .record(send_entry("other-tab", Some("req-1"), Some("tab-2")))
            .unwrap();
        store
            .record(send_entry("other-request", Some("req-2"), Some("tab-3")))
            .unwrap();

        let ids = |sends: Vec<HistorySummary>| -> Vec<String> {
            sends.into_iter().map(|send| send.id).collect()
        };

        assert_eq!(
            ids(store.load_sends(Some("req-1"), Some("tab-1")).unwrap()),
            vec!["other-tab", "saved", "draft"]
        );
        assert_eq!(
            ids(store.load_sends(None, Some("tab-1")).unwrap()),
            vec!["saved", "draft"]
        );
        assert!(store.load_sends(None, None).unwrap().is_empty());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn set_baseline_marks_one_send_per_request_and_can_clear_it() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());
        store.record(send_entry("a", Some("req-1"), None)).unwrap();
        store.record(send_entry("b", Some("req-1"), None)).unwrap();
        store
            .record(send_entry("other", Some("req-2"), None))
            .unwrap();
        store
            .set_baseline(Some("req-2"), None, Some("other"))
            .unwrap();

        store.set_baseline(Some("req-1"), None, Some("a")).unwrap();
        store.set_baseline(Some("req-1"), None, Some("b")).unwrap();

        let baselines = |request: &str| -> Vec<String> {
            store
                .load_sends(Some(request), None)
                .unwrap()
                .into_iter()
                .filter(|send| send.baseline)
                .map(|send| send.id)
                .collect()
        };
        assert_eq!(baselines("req-1"), vec!["b"]);
        assert_eq!(baselines("req-2"), vec!["other"]);

        store.set_baseline(Some("req-1"), None, None).unwrap();
        assert!(baselines("req-1").is_empty());
        assert_eq!(baselines("req-2"), vec!["other"]);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn set_baseline_fails_with_not_found_for_a_send_of_another_request() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());
        store.record(send_entry("a", Some("req-1"), None)).unwrap();

        let error = store
            .set_baseline(Some("req-2"), None, Some("a"))
            .unwrap_err();

        assert!(matches!(error, StorageError::NotFound(_)));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn record_keeps_a_baseline_older_than_the_retention_window() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), Duration::from_secs(60));
        let old = success_entry("entry-old", SystemTime::now() - Duration::from_secs(120))
            .with_source(Some("req-1".to_string()), None);
        let old_plain = success_entry("entry-plain", SystemTime::now() - Duration::from_secs(120));
        // Gravadas com retenção longa para não serem podadas na própria gravação.
        let seeding = HistoryStore::new(root.clone(), week());
        seeding.record(old).unwrap();
        seeding.record(old_plain).unwrap();
        store
            .set_baseline(Some("req-1"), None, Some("entry-old"))
            .unwrap();

        store
            .record(success_entry("entry-new", SystemTime::now()))
            .unwrap();

        let ids: Vec<String> = store
            .load_summaries()
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect();
        assert_eq!(ids, vec!["entry-new", "entry-old"]);
        assert!(root.join(DETAIL_DIR_NAME).join("entry-old.json").exists());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn loads_an_index_entry_that_still_has_a_fingerprint_field() {
        let root = temp_root();
        let store = HistoryStore::new(root.clone(), week());
        store
            .record(send_entry("entry-1", Some("req-1"), None))
            .unwrap();
        // Entradas gravadas enquanto o índice guardava a impressão digital da
        // resposta: o campo é ignorado na leitura.
        let raw = fs::read_to_string(root.join(MANIFEST_FILE_NAME)).unwrap();
        let with_fingerprint = raw.replacen(
            "\"request_id\"",
            "\"fingerprint\":{\"strict\":\"abc\"},\"request_id\"",
            1,
        );
        assert_ne!(raw, with_fingerprint);
        fs::write(root.join(MANIFEST_FILE_NAME), with_fingerprint).unwrap();

        let sends = store.load_sends(Some("req-1"), None).unwrap();

        assert_eq!(sends.len(), 1);
        assert!(store.load_entry("entry-1").unwrap().is_some());

        fs::remove_dir_all(&root).ok();
    }
}
