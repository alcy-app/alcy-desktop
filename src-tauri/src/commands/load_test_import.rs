use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use alcy_app::{LoadFlowError, content_hash, plan_load_flow};
use alcy_collection_import::{
    LoadImportAnalysis, LoadImportDiagnostic, LoadImportFormat, LoadTestImportError,
    analyze_load_test,
};
use alcy_storage::FlowStore;
use serde::{Deserialize, Serialize};

use crate::commands::flows::{FlowDto, flow_to_dto};

const ASSET_DIRECTORY: &str = "alcy-flow-assets";
const MAX_IMPORT_SOURCE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeLoadTestImportInput {
    pub source_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitLoadTestImportInput {
    pub root_path: String,
    pub source_path: String,
    pub analysis_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadImportDiagnosticDto {
    pub line: usize,
    pub column: usize,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadTestImportAnalysisDto {
    pub format: String,
    pub analysis_hash: String,
    pub flow: FlowDto,
    pub destinations: Vec<String>,
    pub blocks: usize,
    pub assets: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LoadTestImportErrorDto {
    InvalidSource {
        message: String,
    },
    Incompatible {
        diagnostics: Vec<LoadImportDiagnosticDto>,
    },
    StaleAnalysis,
    Storage {
        message: String,
    },
}

impl From<LoadTestImportError> for LoadTestImportErrorDto {
    fn from(error: LoadTestImportError) -> Self {
        match error {
            LoadTestImportError::Incompatible { diagnostics } => Self::Incompatible {
                diagnostics: diagnostics.into_iter().map(diagnostic_to_dto).collect(),
            },
            other => Self::InvalidSource {
                message: other.to_string(),
            },
        }
    }
}

#[tauri::command]
pub fn analyze_load_test_import(
    input: AnalyzeLoadTestImportInput,
) -> Result<LoadTestImportAnalysisDto, LoadTestImportErrorDto> {
    crate::logging::logged_with(
        "alcy::load-import",
        "analisar importação de teste de carga",
        || {
            let (name, bytes) = read_source(&input.source_path)?;
            let source =
                std::str::from_utf8(&bytes).map_err(|_| LoadTestImportErrorDto::InvalidSource {
                    message: "o arquivo precisa estar em UTF-8".to_string(),
                })?;
            let mut analysis = analyze_load_test(&name, source, SystemTime::now())
                .map_err(LoadTestImportErrorDto::from)?;
            validate_execution(&analysis)?;
            analysis.flow.id = provisional_flow_id(&bytes);
            Ok(analysis_to_dto(analysis, content_hash(&bytes)))
        },
    )
}

/// Reanalisa imediatamente antes de persistir; o hash recebido impede que o
/// preview confirme outro arquivo após uma edição no editor externo. O asset
/// é escrito em diretório temporário e só ganha o nome final quando o flow já
/// foi validado e salvo. Se qualquer passo falhar, a cópia temporária/final é
/// removida e nenhum flow novo é devolvido.
#[tauri::command]
pub fn commit_load_test_import(
    input: CommitLoadTestImportInput,
) -> Result<FlowDto, LoadTestImportErrorDto> {
    crate::logging::logged_with(
        "alcy::load-import",
        "confirmar importação de teste de carga",
        || {
            let (name, bytes) = read_source(&input.source_path)?;
            let actual_hash = content_hash(&bytes);
            if actual_hash != input.analysis_hash {
                return Err(LoadTestImportErrorDto::StaleAnalysis);
            }
            let source =
                std::str::from_utf8(&bytes).map_err(|_| LoadTestImportErrorDto::InvalidSource {
                    message: "o arquivo precisa estar em UTF-8".to_string(),
                })?;
            let mut analysis = analyze_load_test(&name, source, SystemTime::now())
                .map_err(LoadTestImportErrorDto::from)?;
            validate_execution(&analysis)?;
            analysis.flow.id = committed_flow_id();

            let root = PathBuf::from(&input.root_path);
            let store = FlowStore::new(root.clone());
            let mut snapshot = store
                .load()
                .map_err(|error| LoadTestImportErrorDto::Storage {
                    message: error.to_string(),
                })?;
            if snapshot
                .flows
                .iter()
                .any(|flow| flow.id == analysis.flow.id)
            {
                return Err(LoadTestImportErrorDto::Storage {
                    message: "colisão de identificador ao importar flow".to_string(),
                });
            }

            let (temporary_assets, final_assets) = stage_assets(&root, &analysis, &name, &bytes)?;
            snapshot.flows.push(analysis.flow.clone());
            if let Err(error) = store.save(&snapshot) {
                let _ = fs::remove_dir_all(&temporary_assets);
                return Err(LoadTestImportErrorDto::Storage {
                    message: error.to_string(),
                });
            }
            if let Err(error) = fs::rename(&temporary_assets, &final_assets) {
                // O flow já foi gravado. Restaura o snapshot anterior para que o
                // commit não deixe referência canônica sem seus assets.
                snapshot.flows.retain(|flow| flow.id != analysis.flow.id);
                let _ = store.save(&snapshot);
                let _ = fs::remove_dir_all(&temporary_assets);
                return Err(LoadTestImportErrorDto::Storage {
                    message: format!("não foi possível finalizar os assets: {error}"),
                });
            }
            Ok(flow_to_dto(&analysis.flow))
        },
    )
}

/// O preview e o commit só aceitam grafos que o runtime sabe compilar. A
/// conversão sintática por si só não demonstra suporte de execução.
fn validate_execution(analysis: &LoadImportAnalysis) -> Result<(), LoadTestImportErrorDto> {
    plan_load_flow(&analysis.flow).map(|_| ()).map_err(|error| {
        let node_id = match &error {
            LoadFlowError::InvalidScenarioConfig { node_id, .. }
            | LoadFlowError::InvalidRequestConfig { node_id, .. }
            | LoadFlowError::InvalidCheckConfig { node_id, .. }
            | LoadFlowError::InvalidMetricConfig { node_id, .. }
            | LoadFlowError::InvalidThresholdConfig { node_id, .. } => Some(node_id.as_str()),
            LoadFlowError::InvalidScenarioBody { scenario_id, .. } => Some(scenario_id.as_str()),
            _ => None,
        };
        let line = analysis
            .flow
            .nodes()
            .iter()
            .find(|node| Some(node.id.as_str()) == node_id)
            .and_then(|flow_node| match &flow_node.kind {
                alcy_domain::FlowNodeKind::Load { node } => {
                    serde_json::from_str::<serde_json::Value>(&node.config).ok()
                }
                _ => None,
            })
            .and_then(|config| config.get("source")?.get("line")?.as_u64())
            .and_then(|line| usize::try_from(line).ok())
            .unwrap_or(1);
        LoadTestImportErrorDto::Incompatible {
            diagnostics: vec![LoadImportDiagnosticDto {
                line,
                column: 1,
                message: error.to_string(),
            }],
        }
    })
}

fn read_source(source_path: &str) -> Result<(String, Vec<u8>), LoadTestImportErrorDto> {
    let path = PathBuf::from(source_path);
    let metadata =
        fs::symlink_metadata(&path).map_err(|error| LoadTestImportErrorDto::InvalidSource {
            message: error.to_string(),
        })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(LoadTestImportErrorDto::InvalidSource {
            message: "a fonte precisa ser um arquivo local regular, não um symlink".to_string(),
        });
    }
    if metadata.len() > MAX_IMPORT_SOURCE_BYTES {
        return Err(LoadTestImportErrorDto::InvalidSource {
            message: format!("arquivo excede o limite de {MAX_IMPORT_SOURCE_BYTES} bytes"),
        });
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| LoadTestImportErrorDto::InvalidSource {
            message: "nome de arquivo inválido".to_string(),
        })?
        .to_string();
    let bytes = fs::read(path).map_err(|error| LoadTestImportErrorDto::InvalidSource {
        message: error.to_string(),
    })?;
    Ok((name, bytes))
}

fn stage_assets(
    root: &Path,
    analysis: &LoadImportAnalysis,
    source_name: &str,
    bytes: &[u8],
) -> Result<(PathBuf, PathBuf), LoadTestImportErrorDto> {
    let base = root.join(ASSET_DIRECTORY);
    let final_assets = base.join(&analysis.flow.id);
    if final_assets.exists() {
        return Err(LoadTestImportErrorDto::Storage {
            message: "diretório de assets já existe".to_string(),
        });
    }
    let temporary_assets = base.join(format!(".{}.importing", analysis.flow.id));
    if temporary_assets.exists() {
        return Err(LoadTestImportErrorDto::Storage {
            message: "já existe uma importação em andamento para este flow".to_string(),
        });
    }
    fs::create_dir_all(&temporary_assets).map_err(|error| LoadTestImportErrorDto::Storage {
        message: error.to_string(),
    })?;
    let extension = source_name
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or("txt");
    let target = temporary_assets.join(format!("source.{extension}"));
    fs::write(target, bytes).map_err(|error| {
        let _ = fs::remove_dir_all(&temporary_assets);
        LoadTestImportErrorDto::Storage {
            message: error.to_string(),
        }
    })?;
    Ok((temporary_assets, final_assets))
}

fn provisional_flow_id(bytes: &[u8]) -> String {
    format!("load-preview-{}", &content_hash(bytes)[..16])
}
fn committed_flow_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("load-{nanos:x}")
}

fn analysis_to_dto(
    analysis: LoadImportAnalysis,
    analysis_hash: String,
) -> LoadTestImportAnalysisDto {
    let format = match analysis.format {
        LoadImportFormat::K6 => "k6",
        LoadImportFormat::Jmeter => "jmeter",
    }
    .to_string();
    let destinations = analysis
        .requests
        .iter()
        .map(|request| request.url.clone())
        .collect();
    let blocks = analysis.flow.nodes().len();
    LoadTestImportAnalysisDto {
        format,
        analysis_hash,
        flow: flow_to_dto(&analysis.flow),
        destinations,
        blocks,
        assets: analysis.assets,
    }
}

fn diagnostic_to_dto(diagnostic: LoadImportDiagnostic) -> LoadImportDiagnosticDto {
    LoadImportDiagnosticDto {
        line: diagnostic.line,
        column: diagnostic.column,
        message: diagnostic.message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::pending;
    use std::sync::atomic::{AtomicU64, Ordering};

    use alcy_app::{
        FlowCancellation, LoadRunProgress, LoadRunSink, LoadRunSummary, RequestExecutor,
        execute_load_flow_report,
    };
    use alcy_domain::{ExecutionError, HttpMethod, Request, Response, ResponseMetadata};

    use crate::commands::flows::FlowNodeKindDto;

    static COUNTER: AtomicU64 = AtomicU64::new(0);
    fn temp_file(name: &str, body: &str) -> PathBuf {
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "alcy-load-import-{}-{id}-{name}",
            std::process::id()
        ));
        fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn analysis_never_executes_and_returns_a_hash_for_commit() {
        let path = temp_file(
            "smoke.js",
            "import http from 'k6/http'; export default function () { http.get('https://api.example.test'); }",
        );
        let result = analyze_load_test_import(AnalyzeLoadTestImportInput {
            source_path: path.to_string_lossy().to_string(),
        })
        .unwrap();
        assert_eq!(result.format, "k6");
        assert_eq!(result.destinations, vec!["https://api.example.test"]);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn preview_accepts_a_literal_k6_request_timeout_that_the_runner_can_compile() {
        let path = temp_file(
            "request-timeout.js",
            "import http from 'k6/http'; export default function () { http.get('https://api.example.test', { timeout: '250ms' }); }",
        );
        let preview = analyze_load_test_import(AnalyzeLoadTestImportInput {
            source_path: path.to_string_lossy().into_owned(),
        })
        .unwrap();
        let config = preview
            .flow
            .nodes
            .iter()
            .find_map(|node| match &node.kind {
                FlowNodeKindDto::Load {
                    load_kind: crate::commands::flows::LoadNodeKindDto::Request,
                    config,
                    ..
                } => Some(config),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(config).unwrap()["timeoutMs"],
            250
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn preview_accepts_a_finite_jmeter_thread_group_that_the_runner_can_compile() {
        let path = temp_file(
            "finite-thread-group.jmx",
            r#"<jmeterTestPlan><hashTree><ThreadGroup testname="Smoke">
                <stringProp name="ThreadGroup.num_threads">2</stringProp>
                <stringProp name="ThreadGroup.ramp_time">0</stringProp>
                <intProp name="LoopController.loops">3</intProp>
                <HTTPSamplerProxy testname="health">
                    <stringProp name="HTTPSampler.protocol">https</stringProp>
                    <stringProp name="HTTPSampler.domain">api.example.test</stringProp>
                    <stringProp name="HTTPSampler.path">health</stringProp>
                </HTTPSamplerProxy>
            </ThreadGroup></hashTree></jmeterTestPlan>"#,
        );

        let preview = analyze_load_test_import(AnalyzeLoadTestImportInput {
            source_path: path.to_string_lossy().into_owned(),
        })
        .unwrap();
        let config = preview
            .flow
            .nodes
            .iter()
            .find_map(|node| match &node.kind {
                FlowNodeKindDto::Load {
                    load_kind: crate::commands::flows::LoadNodeKindDto::Scenario,
                    config,
                    ..
                } => Some(config),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(config).unwrap(),
            serde_json::json!({
                "sourceFormat": "jmeter",
                "executor": "perVuIterations",
                "name": "Smoke",
                "vus": 2,
                "iterationsPerVu": 3,
                "sourceProperties": {
                    "ThreadGroup.num_threads": "2",
                    "ThreadGroup.ramp_time": "0",
                    "LoopController.loops": "3",
                },
            })
        );
        fs::remove_file(path).unwrap();
    }

    struct RecordingExecutor(AtomicU64);

    impl RequestExecutor for RecordingExecutor {
        async fn execute(&self, request: &Request) -> Result<Response, ExecutionError> {
            assert_eq!(request.method, HttpMethod::Get);
            assert_eq!(request.endpoint.url(), "https://api.example.test/health");
            assert!(request.document.body.is_empty());
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(Response::new(
                200,
                0,
                "",
                Vec::new(),
                ResponseMetadata::default(),
            ))
        }
    }

    struct SilentSink;

    impl LoadRunSink for SilentSink {
        fn progress(&self, _snapshot: LoadRunProgress) {}
        fn scenario_finished(&self, _scenario_id: &str, _summary: LoadRunSummary) {}
    }

    struct NeverCancelled;

    impl FlowCancellation for NeverCancelled {
        fn is_cancelled(&self) -> bool {
            false
        }
        async fn cancelled(&self) {
            pending().await
        }
    }

    #[tokio::test]
    async fn imported_get_round_trips_through_storage_and_executes_counter_thresholds() {
        let source = "import http from 'k6/http'; import { Counter } from 'k6/metrics'; export const options = { vus: 2, iterations: 3, thresholds: { processed: ['count==15'] } }; const processed = new Counter('processed'); export default function () { http.get('https://api.example.test/health'); processed.add(5); }";
        let path = temp_file("round-trip.js", source);
        let root = path.with_extension("workspace");
        let preview = analyze_load_test_import(AnalyzeLoadTestImportInput {
            source_path: path.to_string_lossy().to_string(),
        })
        .unwrap();
        let committed = commit_load_test_import(CommitLoadTestImportInput {
            root_path: root.to_string_lossy().to_string(),
            source_path: path.to_string_lossy().to_string(),
            analysis_hash: preview.analysis_hash,
        })
        .unwrap();
        let snapshot = FlowStore::new(root.clone()).load().unwrap();
        let flow = snapshot
            .flows
            .iter()
            .find(|flow| flow.id == committed.id)
            .unwrap();
        let executor = RecordingExecutor(AtomicU64::new(0));
        let report = execute_load_flow_report(flow, &executor, &SilentSink, &NeverCancelled)
            .await
            .unwrap();
        assert_eq!(report.summary.requests, 3);
        assert_eq!(report.summary.completed_iterations, 3);
        assert_eq!(executor.0.load(Ordering::Relaxed), 3);
        assert!(report.passed);
        assert_eq!(report.thresholds[0].actual, Some(15.0));
        assert_eq!(
            fs::read_to_string(
                root.join(ASSET_DIRECTORY)
                    .join(&committed.id)
                    .join("source.js")
            )
            .unwrap(),
            source
        );
        fs::remove_dir_all(root).unwrap();
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn preview_and_commit_reject_non_executable_imports_without_creating_workspace_or_assets() {
        let source = "<jmeterTestPlan><hashTree><ThreadGroup testname='Smoke'><HTTPSamplerProxy><stringProp name='HTTPSampler.domain'>api.example.test</stringProp></HTTPSamplerProxy></ThreadGroup></hashTree></jmeterTestPlan>";
        let path = temp_file("unsupported-runtime.jmx", source);
        let root = path.with_extension("workspace");
        let preview = analyze_load_test_import(AnalyzeLoadTestImportInput {
            source_path: path.to_string_lossy().to_string(),
        });
        assert!(matches!(
            preview,
            Err(LoadTestImportErrorDto::Incompatible { .. })
        ));
        let committed = commit_load_test_import(CommitLoadTestImportInput {
            root_path: root.to_string_lossy().to_string(),
            source_path: path.to_string_lossy().to_string(),
            analysis_hash: content_hash(source.as_bytes()),
        });
        assert!(matches!(
            committed,
            Err(LoadTestImportErrorDto::Incompatible { .. })
        ));
        assert!(!root.exists());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn oversized_load_is_rejected_by_preview_and_commit_before_assets_are_created() {
        let source = "import http from 'k6/http'; export const options = { vus: 4097, iterations: 1 }; export default function () { http.get('https://api.example.test/health'); }";
        let path = temp_file("resource-limits.js", source);
        let root = path.with_extension("workspace");
        for result in [
            analyze_load_test_import(AnalyzeLoadTestImportInput {
                source_path: path.to_string_lossy().into_owned(),
            })
            .map(|_| ()),
            commit_load_test_import(CommitLoadTestImportInput {
                root_path: root.to_string_lossy().into_owned(),
                source_path: path.to_string_lossy().into_owned(),
                analysis_hash: content_hash(source.as_bytes()),
            })
            .map(|_| ()),
        ] {
            match result {
                Err(LoadTestImportErrorDto::Incompatible { diagnostics }) => assert!(
                    diagnostics
                        .iter()
                        .any(|d| d.message.contains("VUs simultâneos"))
                ),
                other => panic!("rejeição de budget esperada: {other:?}"),
            }
        }
        assert!(!root.exists());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn commit_rejects_changed_source_without_creating_workspace() {
        let path = temp_file(
            "changed-source.js",
            "import http from 'k6/http'; export default function () { http.get('https://api.example.test'); }",
        );
        let root = path.with_extension("workspace");
        let preview = analyze_load_test_import(AnalyzeLoadTestImportInput {
            source_path: path.to_string_lossy().to_string(),
        })
        .unwrap();
        fs::write(&path, "changed source").unwrap();
        assert!(matches!(
            commit_load_test_import(CommitLoadTestImportInput {
                root_path: root.to_string_lossy().to_string(),
                source_path: path.to_string_lossy().to_string(),
                analysis_hash: preview.analysis_hash,
            }),
            Err(LoadTestImportErrorDto::StaleAnalysis)
        ));
        assert!(!root.exists());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn preview_rejects_counter_rate_and_reports_the_line_of_invalid_request_headers() {
        let rate = temp_file(
            "counter-rate.js",
            "import http from 'k6/http'; export const options = { vus: 1, iterations: 1, thresholds: { http_reqs: ['rate>1'] } }; export default function () { http.get('https://api.example.test'); }",
        );
        assert!(matches!(
            analyze_load_test_import(AnalyzeLoadTestImportInput {
                source_path: rate.to_string_lossy().to_string(),
            }),
            Err(LoadTestImportErrorDto::Incompatible { .. })
        ));
        fs::remove_file(rate).unwrap();
        let headers = temp_file(
            "invalid-header.js",
            "import http from 'k6/http';\nexport default function () {\nhttp.get('https://api.example.test', { headers: { 'Invalid Header': 'value' } });\n}",
        );
        let Err(LoadTestImportErrorDto::Incompatible { diagnostics }) =
            analyze_load_test_import(AnalyzeLoadTestImportInput {
                source_path: headers.to_string_lossy().to_string(),
            })
        else {
            panic!("headers inválidos deveriam impedir a importação");
        };
        assert_eq!(diagnostics[0].line, 3);
        fs::remove_file(headers).unwrap();
    }
}
