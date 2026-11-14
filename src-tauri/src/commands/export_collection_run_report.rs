//! Exporta o relatório de um run do runner de coleções (spec 0074). O
//! relatório é montado aqui, a partir do registro do run: o último run fica
//! em memória (com as respostas guardadas) e os anteriores vêm do histórico.
//! Assim as respostas não atravessam o IPC.

use std::fs;
use std::path::{Path, PathBuf};

use alcy_storage::{
    CollectionRunHistoryStore, CollectionRunRecord, ReportContext, ReportFormat, ReportLanguage,
    render_report,
};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::commands::execute_collection_run::CollectionRunOutputs;
use crate::commands::execute_graphql_request::DEFAULT_HISTORY_RETENTION;
use crate::commands::save_dialog::{
    SaveFilter, SaveOutcome, choose_save_path, record_saved_export, safe_file_name,
};

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReportFormatInput {
    Html,
    Json,
    Junit,
}

impl From<ReportFormatInput> for ReportFormat {
    fn from(format: ReportFormatInput) -> Self {
        match format {
            ReportFormatInput::Html => Self::Html,
            ReportFormatInput::Json => Self::Json,
            ReportFormatInput::Junit => Self::Junit,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCollectionRunReportInput {
    pub root_path: String,
    pub run_id: String,
    /// No destination path: the backend asks for it in the save dialog
    /// (ADR 0081).
    pub suggested_name: String,
    pub format: ReportFormatInput,
    /// Idioma do app (`pt-BR` ou `en`); o relatório HTML segue o mesmo.
    #[serde(default)]
    pub language: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExportCollectionRunReportError {
    NotFound,
    Storage { message: String },
}

#[tauri::command]
pub async fn export_collection_run_report(
    input: ExportCollectionRunReportInput,
    app: AppHandle,
    window: tauri::WebviewWindow,
    outputs: tauri::State<'_, CollectionRunOutputs>,
    usage: tauri::State<'_, alcy_app::UsageHub>,
) -> Result<SaveOutcome, ExportCollectionRunReportError> {
    let result: Result<SaveOutcome, ExportCollectionRunReportError> = async {
        let (filter_name, extension) = match input.format {
            ReportFormatInput::Html => ("HTML", "html"),
            ReportFormatInput::Json => ("JSON", "json"),
            ReportFormatInput::Junit => ("JUnit XML", "xml"),
        };
        let file_name = safe_file_name(&input.suggested_name, "run", Some(extension));
        let filters = [SaveFilter {
            name: filter_name,
            extensions: &[extension],
        }];
        let Some(path) = choose_save_path(&window, file_name, &filters).await else {
            return Ok(SaveOutcome::Cancelled);
        };
        let in_memory = outputs.record(&input.run_id);
        let context = ReportContext {
            app_version: app.package_info().version.to_string(),
            language: match input.language.as_deref() {
                Some(language) if language.starts_with("en") => ReportLanguage::En,
                _ => ReportLanguage::PtBr,
            },
        };
        tauri::async_runtime::spawn_blocking(move || {
            export_inner(input, &path, in_memory, &context)
        })
        .await
        .unwrap_or_else(|error| {
            Err(ExportCollectionRunReportError::Storage {
                message: error.to_string(),
            })
        })?;
        Ok(SaveOutcome::Saved)
    }
    .await;
    record_saved_export(&usage, "runReport", &result);
    crate::logging::logged("alcy::export", "exportar relatório de execução", result)
}

fn export_inner(
    input: ExportCollectionRunReportInput,
    path: &Path,
    in_memory: Option<CollectionRunRecord>,
    context: &ReportContext,
) -> Result<(), ExportCollectionRunReportError> {
    let record = match in_memory {
        Some(record) => record,
        None => CollectionRunHistoryStore::new(
            PathBuf::from(&input.root_path),
            DEFAULT_HISTORY_RETENTION,
        )
        .load_record(&input.run_id)
        .map_err(|error| ExportCollectionRunReportError::Storage {
            message: error.to_string(),
        })?
        .ok_or(ExportCollectionRunReportError::NotFound)?,
    };
    let content = render_report(&record, input.format.into(), context);
    fs::write(path, content).map_err(|error| ExportCollectionRunReportError::Storage {
        message: error.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    use alcy_storage::{RecordedRunOptions, RecordedRunStep, RecordedStepOutcome};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("alcy-report-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn record(id: &str) -> CollectionRunRecord {
        let started_at = SystemTime::now();
        CollectionRunRecord {
            id: id.to_string(),
            scope_name: "Loja".to_string(),
            environment_name: None,
            started_at,
            finished_at: started_at + Duration::from_millis(10),
            cancelled: false,
            stopped_on_error: false,
            iterations: 1,
            options: RecordedRunOptions {
                iterations: 1,
                delay_ms: 0,
                stop_on_error: false,
                http_errors_fail: true,
                keep_variable_values: true,
                share_cookies: true,
                persist_responses: true,
                disable_logs: false,
                data_file_name: None,
            },
            plan: Vec::new(),
            steps: vec![RecordedRunStep {
                at_ms: 0,
                iteration: 0,
                position: 0,
                request_id: "r".to_string(),
                name: "Login".to_string(),
                protocol: Some("rest".to_string()),
                method: "post".to_string(),
                resolved_url: "https://api.test/login".to_string(),
                outcome: RecordedStepOutcome::Passed,
                status_code: Some(200),
                duration_ms: Some(5),
                size_bytes: Some(2),
                error_message: None,
                tests: Vec::new(),
                logs: Vec::new(),
            }],
            outputs: Vec::new(),
        }
    }

    fn context() -> ReportContext {
        ReportContext {
            app_version: "0.3.0".to_string(),
            language: ReportLanguage::En,
        }
    }

    fn input(
        root: &std::path::Path,
        run_id: &str,
        format: ReportFormatInput,
    ) -> ExportCollectionRunReportInput {
        ExportCollectionRunReportInput {
            root_path: root.to_string_lossy().to_string(),
            run_id: run_id.to_string(),
            suggested_name: "run".to_string(),
            format,
            language: Some("en".to_string()),
        }
    }

    #[test]
    fn writes_the_report_of_the_run_in_memory() {
        let root = temp_dir("memory");

        export_inner(
            input(&root, "run-1", ReportFormatInput::Junit),
            &root.join("r.xml"),
            Some(record("run-1")),
            &context(),
        )
        .unwrap();

        let xml = fs::read_to_string(root.join("r.xml")).unwrap();
        assert!(xml.contains("<testcase name=\"POST Login\""));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn falls_back_to_the_history_and_reports_missing_runs() {
        let root = temp_dir("history");
        CollectionRunHistoryStore::new(root.clone(), DEFAULT_HISTORY_RETENTION)
            .record(&record("old"))
            .unwrap();

        export_inner(
            input(&root, "old", ReportFormatInput::Html),
            &root.join("r.html"),
            None,
            &context(),
        )
        .unwrap();
        assert!(
            fs::read_to_string(root.join("r.html"))
                .unwrap()
                .contains("<h1>Loja</h1>")
        );

        assert_eq!(
            export_inner(
                input(&root, "missing", ReportFormatInput::Json),
                &root.join("r.json"),
                None,
                &context()
            ),
            Err(ExportCollectionRunReportError::NotFound)
        );
        fs::remove_dir_all(root).unwrap();
    }
}
