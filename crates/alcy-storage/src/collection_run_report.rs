//! Relatórios de um run do runner de coleções (spec 0074): HTML
//! autocontido (abre em qualquer navegador, sem rede), JSON e JUnit XML.
//! Funções puras: recebem o registro do run e devolvem o texto do arquivo.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::collection_run_history_store::{
    CollectionRunRecord, CollectionRunStatus, RecordedPlanItem, RecordedRunStep,
    RecordedStepOutcome, RecordedStepOutput, RecordedTest,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportFormat {
    Html,
    Json,
    Junit,
}

impl ReportFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Html => "html",
            Self::Json => "json",
            Self::Junit => "xml",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportLanguage {
    PtBr,
    En,
}

#[derive(Debug, Clone)]
pub struct ReportContext {
    pub app_version: String,
    pub language: ReportLanguage,
}

pub fn render_report(
    record: &CollectionRunRecord,
    format: ReportFormat,
    context: &ReportContext,
) -> String {
    let rows = report_rows(record);
    match format {
        ReportFormat::Html => render_html(record, &rows, context),
        ReportFormat::Json => render_json(record, &rows, context),
        ReportFormat::Junit => render_junit(record, &rows),
    }
}

/// Resultado de uma linha do relatório: `Skipped` inclui a requisição
/// cancelada em voo e as do plano que não chegaram a rodar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RowOutcome {
    Passed,
    Failed,
    Error,
    Skipped,
}

impl RowOutcome {
    fn key(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::Error => "error",
            Self::Skipped => "skipped",
        }
    }
}

struct Row<'a> {
    iteration: u32,
    step: Option<&'a RecordedRunStep>,
    plan: Option<&'a RecordedPlanItem>,
    output: Option<&'a RecordedStepOutput>,
    outcome: RowOutcome,
}

impl Row<'_> {
    fn name(&self) -> &str {
        self.step
            .map(|step| step.name.as_str())
            .filter(|name| !name.is_empty())
            .or_else(|| self.plan.map(|plan| plan.name.as_str()))
            .unwrap_or("—")
    }

    fn method(&self) -> String {
        let protocol = self
            .step
            .and_then(|step| step.protocol.as_deref())
            .or_else(|| self.plan.map(|plan| plan.protocol.as_str()));
        match protocol {
            Some("graphql") => return "GQL".to_string(),
            Some("grpc") => return "gRPC".to_string(),
            _ => {}
        }
        self.step
            .map(|step| step.method.as_str())
            .or_else(|| self.plan.map(|plan| plan.method.as_str()))
            .unwrap_or("")
            .to_uppercase()
    }

    fn tests(&self) -> &[RecordedTest] {
        self.step.map(|step| step.tests.as_slice()).unwrap_or(&[])
    }
}

/// Linhas na ordem iteração → posição do plano, com as puladas incluídas.
fn report_rows(record: &CollectionRunRecord) -> Vec<Row<'_>> {
    let output_for = |iteration: u32, position: usize| {
        record
            .outputs
            .iter()
            .find(|output| output.iteration == iteration && output.position == position)
    };
    let row_for_step = |step: &'_ RecordedRunStep| -> RowOutcome {
        match step.outcome {
            RecordedStepOutcome::Passed => RowOutcome::Passed,
            RecordedStepOutcome::Failed => RowOutcome::Failed,
            RecordedStepOutcome::Error => RowOutcome::Error,
            RecordedStepOutcome::Cancelled => RowOutcome::Skipped,
        }
    };

    if record.plan.is_empty() {
        return record
            .steps
            .iter()
            .map(|step| Row {
                iteration: step.iteration,
                step: Some(step),
                plan: None,
                output: output_for(step.iteration, step.position),
                outcome: row_for_step(step),
            })
            .collect();
    }

    let iterations = record.iterations.max(1);
    let mut rows = Vec::with_capacity(iterations as usize * record.plan.len());
    for iteration in 0..iterations {
        for (position, plan) in record.plan.iter().enumerate() {
            let step = record
                .steps
                .iter()
                .find(|step| step.iteration == iteration && step.position == position);
            rows.push(Row {
                iteration,
                step,
                plan: Some(plan),
                output: output_for(iteration, position),
                outcome: step.map(row_for_step).unwrap_or(RowOutcome::Skipped),
            });
        }
    }
    rows
}

struct Totals {
    requests: usize,
    passed: usize,
    failed: usize,
    errors: usize,
    skipped: usize,
    tests: usize,
    tests_passed: usize,
    received_bytes: usize,
    average_ms: Option<u64>,
}

fn totals(rows: &[Row<'_>]) -> Totals {
    let count = |outcome| rows.iter().filter(|row| row.outcome == outcome).count();
    let timed: Vec<u64> = rows
        .iter()
        .filter_map(|row| row.step.and_then(|step| step.duration_ms))
        .collect();
    Totals {
        requests: rows.len(),
        passed: count(RowOutcome::Passed),
        failed: count(RowOutcome::Failed),
        errors: count(RowOutcome::Error),
        skipped: count(RowOutcome::Skipped),
        tests: rows.iter().map(|row| row.tests().len()).sum(),
        tests_passed: rows
            .iter()
            .map(|row| row.tests().iter().filter(|test| test.passed).count())
            .sum(),
        received_bytes: rows
            .iter()
            .filter_map(|row| row.step.and_then(|step| step.size_bytes))
            .sum(),
        average_ms: (!timed.is_empty()).then(|| timed.iter().sum::<u64>() / timed.len() as u64),
    }
}

fn status_key(record: &CollectionRunRecord) -> &'static str {
    match record.status() {
        CollectionRunStatus::Cancelled => "cancelled",
        _ if record.stopped_on_error => "stopped",
        CollectionRunStatus::Failed => "failed",
        CollectionRunStatus::Completed => "passed",
    }
}

fn millis(instant: SystemTime) -> u64 {
    instant
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}

fn run_duration_ms(record: &CollectionRunRecord) -> u64 {
    record
        .finished_at
        .duration_since(record.started_at)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}

/// Instante em ISO 8601 (UTC), sem depender de uma crate de datas.
fn iso_utc(ms: u64) -> String {
    let seconds = (ms / 1000) as i64;
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // Algoritmo civil_from_days de Howard Hinnant.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60,
        ms % 1000
    )
}

fn format_duration(ms: u64) -> String {
    if ms < 1000 {
        format!("{ms} ms")
    } else if ms < 60_000 {
        format!("{:.2} s", ms as f64 / 1000.0)
    } else {
        format!("{} min {} s", ms / 60_000, (ms % 60_000) / 1000)
    }
}

fn format_size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

// ---------------------------------------------------------------- JSON

fn render_json(record: &CollectionRunRecord, rows: &[Row<'_>], context: &ReportContext) -> String {
    let totals = totals(rows);
    let iterations: Vec<Value> = (0..record.iterations.max(1))
        .map(|iteration| {
            let results: Vec<Value> = rows
                .iter()
                .filter(|row| row.iteration == iteration)
                .map(|row| {
                    let step = row.step;
                    json!({
                        "name": row.name(),
                        "method": row.method(),
                        "protocol": step.and_then(|s| s.protocol.clone())
                            .or_else(|| row.plan.map(|p| p.protocol.clone())),
                        "url": step.map(|s| s.resolved_url.clone()),
                        "outcome": row.outcome.key(),
                        "statusCode": step.and_then(|s| s.status_code),
                        "durationMs": step.and_then(|s| s.duration_ms),
                        "sizeBytes": step.and_then(|s| s.size_bytes),
                        "error": step.and_then(|s| s.error_message.clone()),
                        "tests": row.tests().iter().map(|test| json!({
                            "name": test.name,
                            "passed": test.passed,
                            "message": test.message,
                        })).collect::<Vec<_>>(),
                        "logs": step.map(|s| s.logs.clone()).unwrap_or_default(),
                        "response": row.output.map(|output| json!({
                            "headers": output.headers.iter()
                                .map(|(name, value)| json!({ "name": name, "value": value }))
                                .collect::<Vec<_>>(),
                            "body": if output.base64 { Value::Null } else { Value::String(output.body.clone()) },
                            "binary": output.base64,
                            "truncated": output.truncated,
                        })),
                    })
                })
                .collect();
            json!({ "iteration": iteration + 1, "results": results })
        })
        .collect();

    let report = json!({
        "tool": "Alcy",
        "version": context.app_version,
        "scope": record.scope_name,
        "environment": record.environment_name,
        "startedAt": iso_utc(millis(record.started_at)),
        "finishedAt": iso_utc(millis(record.finished_at)),
        "durationMs": run_duration_ms(record),
        "status": status_key(record),
        "options": record.options,
        "summary": {
            "requests": {
                "total": totals.requests,
                "passed": totals.passed,
                "failed": totals.failed,
                "errors": totals.errors,
                "skipped": totals.skipped,
            },
            "tests": {
                "total": totals.tests,
                "passed": totals.tests_passed,
                "failed": totals.tests - totals.tests_passed,
            },
            "averageResponseMs": totals.average_ms,
            "receivedBytes": totals.received_bytes,
        },
        "iterations": iterations,
    });
    serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".to_string())
}

// ---------------------------------------------------------------- JUnit

fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // Caracteres de controle não são válidos em XML 1.0.
            c if (c as u32) < 0x20 && !matches!(c, '\n' | '\r' | '\t') => {}
            c => out.push(c),
        }
    }
    out
}

fn seconds(ms: u64) -> String {
    format!("{:.3}", ms as f64 / 1000.0)
}

fn render_junit(record: &CollectionRunRecord, rows: &[Row<'_>]) -> String {
    let all = totals(rows);
    let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    xml.push_str(&format!(
        "<testsuites name=\"{}\" tests=\"{}\" failures=\"{}\" errors=\"{}\" skipped=\"{}\" time=\"{}\">\n",
        xml_escape(&record.scope_name),
        all.requests,
        all.failed,
        all.errors,
        all.skipped,
        seconds(run_duration_ms(record)),
    ));
    for iteration in 0..record.iterations.max(1) {
        let suite: Vec<&Row<'_>> = rows
            .iter()
            .filter(|row| row.iteration == iteration)
            .collect();
        let count = |outcome| suite.iter().filter(|row| row.outcome == outcome).count();
        let time: u64 = suite
            .iter()
            .filter_map(|row| row.step.and_then(|step| step.duration_ms))
            .sum();
        xml.push_str(&format!(
            "  <testsuite name=\"{} #{}\" tests=\"{}\" failures=\"{}\" errors=\"{}\" skipped=\"{}\" time=\"{}\" timestamp=\"{}\">\n",
            xml_escape(&record.scope_name),
            iteration + 1,
            suite.len(),
            count(RowOutcome::Failed),
            count(RowOutcome::Error),
            count(RowOutcome::Skipped),
            seconds(time),
            iso_utc(millis(record.started_at)),
        ));
        for row in suite {
            let step = row.step;
            xml.push_str(&format!(
                "    <testcase name=\"{}\" classname=\"{}\" time=\"{}\"",
                xml_escape(format!("{} {}", row.method(), row.name()).trim()),
                xml_escape(&record.scope_name),
                seconds(step.and_then(|s| s.duration_ms).unwrap_or(0)),
            ));
            let mut body = String::new();
            match row.outcome {
                RowOutcome::Passed => {}
                RowOutcome::Skipped => body.push_str("      <skipped/>\n"),
                RowOutcome::Error => body.push_str(&format!(
                    "      <error message=\"{}\"/>\n",
                    xml_escape(
                        step.and_then(|s| s.error_message.as_deref())
                            .unwrap_or("error")
                    )
                )),
                RowOutcome::Failed => {
                    let failed: Vec<String> = row
                        .tests()
                        .iter()
                        .filter(|test| !test.passed)
                        .map(|test| match &test.message {
                            Some(message) => format!("{}: {message}", test.name),
                            None => test.name.clone(),
                        })
                        .collect();
                    let message = step
                        .and_then(|s| s.error_message.clone())
                        .or_else(|| failed.first().cloned())
                        .or_else(|| {
                            step.and_then(|s| s.status_code)
                                .map(|code| format!("HTTP {code}"))
                        })
                        .unwrap_or_else(|| "failed".to_string());
                    body.push_str(&format!(
                        "      <failure message=\"{}\">{}</failure>\n",
                        xml_escape(&message),
                        xml_escape(&failed.join("\n"))
                    ));
                }
            }
            if let Some(step) = step.filter(|s| !s.logs.is_empty()) {
                body.push_str(&format!(
                    "      <system-out>{}</system-out>\n",
                    xml_escape(&step.logs.join("\n"))
                ));
            }
            if body.is_empty() {
                xml.push_str("/>\n");
            } else {
                xml.push_str(">\n");
                xml.push_str(&body);
                xml.push_str("    </testcase>\n");
            }
        }
        xml.push_str("  </testsuite>\n");
    }
    xml.push_str("</testsuites>\n");
    xml
}

// ---------------------------------------------------------------- HTML

struct Labels {
    lang: &'static str,
    subtitle: &'static str,
    environment: &'static str,
    no_environment: &'static str,
    duration: &'static str,
    iterations: &'static str,
    requests: &'static str,
    tests: &'static str,
    failures: &'static str,
    errors: &'static str,
    average: &'static str,
    received: &'static str,
    data_file: &'static str,
    all: &'static str,
    passed: &'static str,
    failed: &'static str,
    skipped: &'static str,
    iteration: &'static str,
    expand: &'static str,
    collapse: &'static str,
    url: &'static str,
    status: &'static str,
    time: &'static str,
    size: &'static str,
    error: &'static str,
    logs: &'static str,
    response_headers: &'static str,
    response_body: &'static str,
    not_kept: &'static str,
    truncated: &'static str,
    binary: &'static str,
    not_run: &'static str,
    no_tests: &'static str,
    status_passed: &'static str,
    status_failed: &'static str,
    status_stopped: &'static str,
    status_cancelled: &'static str,
    outcome_error: &'static str,
    empty: &'static str,
}

const PT_BR: Labels = Labels {
    lang: "pt-BR",
    subtitle: "Relatório do run",
    environment: "Ambiente",
    no_environment: "Sem ambiente",
    duration: "Duração",
    iterations: "Iterações",
    requests: "Requisições",
    tests: "Testes",
    failures: "Falhas",
    errors: "Erros",
    average: "Tempo médio",
    received: "Dados recebidos",
    data_file: "Dados",
    all: "Todas",
    passed: "Passaram",
    failed: "Falharam",
    skipped: "Puladas",
    iteration: "Iteração",
    expand: "Expandir tudo",
    collapse: "Recolher tudo",
    url: "URL",
    status: "Status",
    time: "Tempo",
    size: "Tamanho",
    error: "Erro",
    logs: "Logs",
    response_headers: "Headers da resposta",
    response_body: "Corpo da resposta",
    not_kept: "Resposta não guardada.",
    truncated: "Truncada",
    binary: "Resposta binária.",
    not_run: "Não executada: o run parou antes desta requisição.",
    no_tests: "Nenhum teste.",
    status_passed: "Concluído",
    status_failed: "Com falhas",
    status_stopped: "Interrompido",
    status_cancelled: "Cancelado",
    outcome_error: "Erro",
    empty: "Nenhum resultado.",
};

const EN: Labels = Labels {
    lang: "en",
    subtitle: "Run report",
    environment: "Environment",
    no_environment: "No environment",
    duration: "Duration",
    iterations: "Iterations",
    requests: "Requests",
    tests: "Tests",
    failures: "Failures",
    errors: "Errors",
    average: "Avg. time",
    received: "Data received",
    data_file: "Data",
    all: "All",
    passed: "Passed",
    failed: "Failed",
    skipped: "Skipped",
    iteration: "Iteration",
    expand: "Expand all",
    collapse: "Collapse all",
    url: "URL",
    status: "Status",
    time: "Time",
    size: "Size",
    error: "Error",
    logs: "Logs",
    response_headers: "Response headers",
    response_body: "Response body",
    not_kept: "Response not kept.",
    truncated: "Truncated",
    binary: "Binary response.",
    not_run: "Not run: the run stopped before this request.",
    no_tests: "No tests.",
    status_passed: "Completed",
    status_failed: "With failures",
    status_stopped: "Stopped",
    status_cancelled: "Cancelled",
    outcome_error: "Error",
    empty: "No results.",
};

fn html_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

fn pretty_body(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| serde_json::to_string_pretty(&value).ok())
        .unwrap_or_else(|| body.to_string())
}

/// Categoria do filtro: erros contam como falha.
fn filter_key(outcome: RowOutcome) -> &'static str {
    match outcome {
        RowOutcome::Passed => "passed",
        RowOutcome::Failed | RowOutcome::Error => "failed",
        RowOutcome::Skipped => "skipped",
    }
}

fn render_html(record: &CollectionRunRecord, rows: &[Row<'_>], context: &ReportContext) -> String {
    let l = match context.language {
        ReportLanguage::PtBr => &PT_BR,
        ReportLanguage::En => &EN,
    };
    let totals = totals(rows);
    let status = status_key(record);
    let status_label = match status {
        "passed" => l.status_passed,
        "stopped" => l.status_stopped,
        "cancelled" => l.status_cancelled,
        _ => l.status_failed,
    };
    let started_ms = millis(record.started_at);

    let mut summary = vec![
        (
            l.environment,
            record
                .environment_name
                .clone()
                .unwrap_or_else(|| l.no_environment.to_string()),
            "",
        ),
        (l.iterations, record.iterations.max(1).to_string(), ""),
    ];
    if let Some(file) = &record.options.data_file_name {
        summary.push((l.data_file, file.clone(), ""));
    }
    summary.extend([
        (l.requests, totals.requests.to_string(), ""),
        (l.duration, format_duration(run_duration_ms(record)), ""),
        (
            l.tests,
            if totals.tests == 0 {
                "0".to_string()
            } else {
                format!("{}/{}", totals.tests_passed, totals.tests)
            },
            if totals.tests_passed < totals.tests {
                "error"
            } else {
                ""
            },
        ),
        (
            l.failures,
            totals.failed.to_string(),
            if totals.failed > 0 { "error" } else { "" },
        ),
        (
            l.errors,
            totals.errors.to_string(),
            if totals.errors > 0 { "warning" } else { "" },
        ),
        (
            l.average,
            totals
                .average_ms
                .map(format_duration)
                .unwrap_or_else(|| "—".to_string()),
            "",
        ),
        (l.received, format_size(totals.received_bytes), ""),
    ]);

    let mut html = String::with_capacity(16 * 1024);
    html.push_str(&format!(
        "<!DOCTYPE html>\n<html lang=\"{lang}\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <meta name=\"generator\" content=\"Alcy {version}\">\n<title>{title} — {subtitle}</title>\n<style>{css}</style>\n</head>\n<body>\n",
        lang = l.lang,
        version = html_escape(&context.app_version),
        title = html_escape(&record.scope_name),
        subtitle = l.subtitle,
        css = REPORT_CSS,
    ));

    html.push_str(&format!(
        "<header class=\"top\">\n<div>\n<h1>{title}</h1>\n<p class=\"meta\"><span class=\"status status--{status}\"><i></i>{status_label}</span>\
         <span><time data-ts=\"{started_ms}\">{started_iso}</time></span><span>{subtitle} · Alcy {version}</span></p>\n</div>\n</header>\n",
        title = html_escape(&record.scope_name),
        started_iso = iso_utc(started_ms),
        subtitle = l.subtitle,
        version = html_escape(&context.app_version),
    ));

    html.push_str("<main>\n<dl class=\"summary\">\n");
    for (label, value, tone) in &summary {
        html.push_str(&format!(
            "<div><dt>{label}</dt><dd class=\"{tone}\">{}</dd></div>\n",
            html_escape(value)
        ));
    }
    html.push_str("</dl>\n");

    html.push_str(&format!(
        "<div class=\"toolbar\">\n<div class=\"filters\" role=\"radiogroup\">\n\
         <button type=\"button\" role=\"radio\" aria-checked=\"true\" data-filter=\"all\">{all} <b>{n_all}</b></button>\n\
         <button type=\"button\" role=\"radio\" aria-checked=\"false\" data-filter=\"passed\">{passed} <b class=\"{t_passed}\">{n_passed}</b></button>\n\
         <button type=\"button\" role=\"radio\" aria-checked=\"false\" data-filter=\"failed\">{failed} <b class=\"{t_failed}\">{n_failed}</b></button>\n\
         <button type=\"button\" role=\"radio\" aria-checked=\"false\" data-filter=\"skipped\">{skipped} <b>{n_skipped}</b></button>\n\
         </div>\n<div class=\"actions\"><button type=\"button\" data-toggle=\"open\">{expand}</button>\
         <button type=\"button\" data-toggle=\"close\">{collapse}</button></div>\n</div>\n",
        all = l.all,
        passed = l.passed,
        failed = l.failed,
        skipped = l.skipped,
        n_all = totals.requests,
        n_passed = totals.passed,
        n_failed = totals.failed + totals.errors,
        n_skipped = totals.skipped,
        t_passed = if totals.passed > 0 { "success" } else { "" },
        t_failed = if totals.failed + totals.errors > 0 { "error" } else { "" },
        expand = l.expand,
        collapse = l.collapse,
    ));

    let show_iterations = record.iterations > 1;
    for iteration in 0..record.iterations.max(1) {
        let iteration_rows: Vec<&Row<'_>> = rows
            .iter()
            .filter(|row| row.iteration == iteration)
            .collect();
        html.push_str("<section class=\"iteration\">\n");
        if show_iterations {
            html.push_str(&format!("<h2>{} {}</h2>\n", l.iteration, iteration + 1));
        }
        for row in iteration_rows {
            html.push_str(&render_html_row(row, l));
        }
        html.push_str("</section>\n");
    }
    html.push_str(&format!("<p class=\"empty\" hidden>{}</p>\n", l.empty));
    html.push_str("</main>\n<script>");
    html.push_str(REPORT_JS);
    html.push_str("</script>\n</body>\n</html>\n");
    html
}

fn render_html_row(row: &Row<'_>, l: &Labels) -> String {
    let step = row.step;
    let tests = row.tests();
    let passed_tests = tests.iter().filter(|test| test.passed).count();
    let outcome = row.outcome;

    let mut meta = String::new();
    if !tests.is_empty() {
        meta.push_str(&format!(
            "<span class=\"chip {}\">{passed_tests}/{} {}</span>",
            if passed_tests == tests.len() {
                "success"
            } else {
                "error"
            },
            tests.len(),
            l.tests.to_lowercase(),
        ));
    }
    if let Some(code) = step.and_then(|s| s.status_code) {
        meta.push_str(&format!(
            "<span class=\"code {}\">{code}</span>",
            if code >= 400 { "error" } else { "success" }
        ));
    }
    if let Some(ms) = step.and_then(|s| s.duration_ms) {
        meta.push_str(&format!("<span class=\"ms\">{ms} ms</span>"));
    }
    if outcome == RowOutcome::Error {
        meta.push_str(&format!(
            "<span class=\"chip warning\">{}</span>",
            l.outcome_error
        ));
    }

    let mut out = format!(
        "<details class=\"row row--{outcome}\" data-filter=\"{filter}\">\n<summary><span class=\"dot\"></span>\
         <span class=\"method\">{method}</span><span class=\"name\">{name}</span><span class=\"row-meta\">{meta}</span></summary>\n<div class=\"body\">\n",
        outcome = outcome.key(),
        filter = filter_key(outcome),
        method = html_escape(&row.method()),
        name = html_escape(row.name()),
    );

    let Some(step) = step else {
        out.push_str(&format!(
            "<p class=\"muted\">{}</p>\n</div>\n</details>\n",
            l.not_run
        ));
        return out;
    };

    out.push_str("<dl class=\"facts\">");
    if !step.resolved_url.is_empty() {
        out.push_str(&format!(
            "<div class=\"wide\"><dt>{}</dt><dd><code>{}</code></dd></div>",
            l.url,
            html_escape(&step.resolved_url)
        ));
    }
    out.push_str(&format!(
        "<div><dt>{}</dt><dd>{}</dd></div><div><dt>{}</dt><dd>{}</dd></div><div><dt>{}</dt><dd>{}</dd></div>",
        l.status,
        step.status_code.map(|c| c.to_string()).unwrap_or_else(|| "—".to_string()),
        l.time,
        step.duration_ms.map(format_duration).unwrap_or_else(|| "—".to_string()),
        l.size,
        step.size_bytes.map(format_size).unwrap_or_else(|| "—".to_string()),
    ));
    out.push_str("</dl>\n");

    if let Some(error) = &step.error_message {
        out.push_str(&format!(
            "<p class=\"error-box\"><strong>{}:</strong> {}</p>\n",
            l.error,
            html_escape(error)
        ));
    }

    out.push_str(&format!("<h3>{}</h3>\n", l.tests));
    if tests.is_empty() {
        out.push_str(&format!("<p class=\"muted\">{}</p>\n", l.no_tests));
    } else {
        out.push_str("<ul class=\"tests\">");
        for test in tests {
            out.push_str(&format!(
                "<li class=\"{}\"><span class=\"mark\">{}</span><span>{}{}</span></li>",
                if test.passed { "pass" } else { "fail" },
                if test.passed { "✓" } else { "✕" },
                html_escape(&test.name),
                test.message
                    .as_deref()
                    .filter(|_| !test.passed)
                    .map(|message| format!("<em>{}</em>", html_escape(message)))
                    .unwrap_or_default(),
            ));
        }
        out.push_str("</ul>\n");
    }

    if !step.logs.is_empty() {
        out.push_str(&format!(
            "<h3>{}</h3>\n<pre>{}</pre>\n",
            l.logs,
            html_escape(&step.logs.join("\n"))
        ));
    }

    match row.output {
        None => out.push_str(&format!(
            "<h3>{}</h3>\n<p class=\"muted\">{}</p>\n",
            l.response_body, l.not_kept
        )),
        Some(output) => {
            if !output.headers.is_empty() {
                out.push_str(&format!(
                    "<h3>{}</h3>\n<table class=\"headers\">",
                    l.response_headers
                ));
                for (name, value) in &output.headers {
                    out.push_str(&format!(
                        "<tr><th>{}</th><td>{}</td></tr>",
                        html_escape(name),
                        html_escape(value)
                    ));
                }
                out.push_str("</table>\n");
            }
            out.push_str(&format!("<h3>{}</h3>\n", l.response_body));
            if output.base64 {
                out.push_str(&format!("<p class=\"muted\">{}</p>\n", l.binary));
            } else {
                out.push_str(&format!(
                    "<pre>{}</pre>\n",
                    html_escape(&pretty_body(&output.body))
                ));
                if output.truncated {
                    out.push_str(&format!(
                        "<p class=\"muted\">{} ({})</p>\n",
                        l.truncated,
                        format_size(output.size_bytes)
                    ));
                }
            }
        }
    }

    out.push_str("</div>\n</details>\n");
    out
}

const REPORT_CSS: &str = r#"
:root{--bg:#f7f7f9;--surface:#fff;--raised:#f1f1f4;--border:#e3e3e8;--text:#1f1f24;--muted:#6b6b76;--accent:#5b4bd6;--success:#1f8a4c;--error:#d1344b;--warning:#b7791f;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#141418;--surface:#1b1b21;--raised:#24242c;--border:#2e2e38;--text:#e8e8ee;--muted:#9a9aa6;--accent:#8b7ff0;--success:#4cc38a;--error:#f16a7e;--warning:#e6b450;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
.top{padding:16px 24px;border-bottom:1px solid var(--border);background:var(--surface)}
h1{margin:0;font-size:16px;font-weight:600}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin:2px 0 0;color:var(--muted);font-size:12px}
.meta>span+span:before{content:"·";margin-right:8px}
.status{display:inline-flex;align-items:center;gap:6px;color:var(--text)}
.status i{width:7px;height:7px;border-radius:50%;background:var(--muted)}
.status--passed i{background:var(--success)}.status--failed i,.status--stopped i{background:var(--error)}
main{max-width:1100px;margin:0 auto;padding:16px 24px 48px}
.summary{display:flex;flex-wrap:wrap;gap:8px 28px;margin:0 0 16px;padding:10px 16px;border:1px solid var(--border);border-radius:6px;background:var(--surface)}
.summary div{display:flex;flex-direction:column;gap:2px}
.summary dt{color:var(--muted);font-size:12px}
.summary dd{margin:0;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.error{color:var(--error)}.warning{color:var(--warning)}.success{color:var(--success)}
.toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px}
.filters,.actions{display:flex;gap:2px}
button{border:0;border-radius:4px;background:none;color:var(--muted);font:inherit;padding:4px 8px;cursor:pointer}
button:hover{color:var(--text)}
button[aria-checked=true]{background:var(--raised);color:var(--text)}
button b{font-weight:500;font-size:12px;color:var(--muted)}
button b.success{color:var(--success)}button b.error{color:var(--error)}
h2{margin:18px 0 8px;font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.row{margin-bottom:6px;border:1px solid var(--border);border-radius:6px;background:var(--surface)}
.row summary{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;list-style:none}
.row summary::-webkit-details-marker{display:none}
.row[open] summary{border-bottom:1px solid var(--border)}
.dot{width:8px;height:8px;flex:none;border-radius:50%;background:var(--muted)}
.row--passed .dot{background:var(--success)}.row--failed .dot{background:var(--error)}.row--error .dot{background:var(--warning)}
.row--skipped{opacity:.7}
.method{min-width:44px;font:600 11px ui-monospace,"JetBrains Mono",monospace;color:var(--accent)}
.name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.row-meta{display:flex;align-items:center;gap:10px;flex:none}
.chip{padding:0 6px;border-radius:4px;background:var(--raised);font-size:11px}
.code{font:600 12px ui-monospace,"JetBrains Mono",monospace}
.ms{min-width:56px;text-align:right;color:var(--muted);font:12px ui-monospace,"JetBrains Mono",monospace}
.body{padding:12px 14px}
.facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0 0 12px}
.facts .wide{grid-column:1/-1}
.facts dt{color:var(--muted);font-size:12px}.facts dd{margin:0}
code,pre{font:12px/1.5 ui-monospace,"JetBrains Mono",monospace}
code{overflow-wrap:anywhere}
pre{max-height:420px;margin:0 0 12px;padding:10px 12px;overflow:auto;border:1px solid var(--border);border-radius:6px;background:var(--raised);white-space:pre-wrap;overflow-wrap:anywhere}
h3{margin:14px 0 6px;font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.muted{margin:0;color:var(--muted)}
.error-box{margin:0 0 8px;padding:8px 10px;border-radius:6px;background:color-mix(in srgb,var(--error) 12%,transparent);color:var(--error)}
.tests{margin:0;padding:0;list-style:none}
.tests li{display:flex;gap:8px;padding:3px 0}
.tests .mark{width:14px;flex:none;font-weight:700}
.tests .pass .mark{color:var(--success)}.tests .fail .mark{color:var(--error)}
.tests em{display:block;color:var(--error);font:12px ui-monospace,"JetBrains Mono",monospace;font-style:normal}
.headers{width:100%;margin-bottom:12px;border-collapse:collapse;font:12px ui-monospace,"JetBrains Mono",monospace}
.headers th{width:30%;padding:3px 8px 3px 0;color:var(--muted);font-weight:400;text-align:left;vertical-align:top}
.headers td{padding:3px 0;overflow-wrap:anywhere}
.empty{color:var(--muted);text-align:center;padding:24px}
@media print{.toolbar{display:none}.row{break-inside:avoid}}
"#;

const REPORT_JS: &str = r#"
(function(){
  var rows=document.querySelectorAll('details.row');
  var empty=document.querySelector('.empty');
  function apply(filter){
    var shown=0;
    rows.forEach(function(row){var ok=filter==='all'||row.dataset.filter===filter;row.hidden=!ok;if(ok)shown++;});
    document.querySelectorAll('section.iteration').forEach(function(section){
      section.hidden=!section.querySelector('details.row:not([hidden])');
    });
    empty.hidden=shown>0;
  }
  document.querySelectorAll('.filters button').forEach(function(button){
    button.addEventListener('click',function(){
      document.querySelectorAll('.filters button').forEach(function(b){b.setAttribute('aria-checked',b===button?'true':'false');});
      apply(button.dataset.filter);
    });
  });
  document.querySelectorAll('[data-toggle]').forEach(function(button){
    button.addEventListener('click',function(){
      var open=button.dataset.toggle==='open';
      rows.forEach(function(row){if(!row.hidden)row.open=open;});
    });
  });
  document.querySelectorAll('time[data-ts]').forEach(function(el){
    el.textContent=new Date(Number(el.dataset.ts)).toLocaleString(document.documentElement.lang);
  });
})();
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collection_run_history_store::RecordedRunOptions;

    fn step(iteration: u32, position: usize, outcome: RecordedStepOutcome) -> RecordedRunStep {
        RecordedRunStep {
            at_ms: 0,
            iteration,
            position,
            request_id: format!("r{position}"),
            name: format!("Req <{position}>"),
            protocol: Some("rest".to_string()),
            method: "get".to_string(),
            resolved_url: "https://api.test/?a=1&b=2".to_string(),
            outcome,
            status_code: Some(if outcome == RecordedStepOutcome::Failed {
                404
            } else {
                200
            }),
            duration_ms: Some(40),
            size_bytes: Some(100),
            error_message: None,
            tests: vec![RecordedTest {
                name: "status".to_string(),
                passed: outcome != RecordedStepOutcome::Failed,
                message: (outcome == RecordedStepOutcome::Failed)
                    .then(|| "esperado 200, recebido 404".to_string()),
            }],
            logs: vec!["log <1>".to_string()],
        }
    }

    fn record() -> CollectionRunRecord {
        let started_at = UNIX_EPOCH + Duration::from_millis(1_790_000_000_123);
        CollectionRunRecord {
            id: "run".to_string(),
            scope_name: "Loja & Cia".to_string(),
            environment_name: Some("Dev".to_string()),
            started_at,
            finished_at: started_at + Duration::from_millis(1500),
            cancelled: false,
            stopped_on_error: true,
            iterations: 2,
            options: RecordedRunOptions {
                iterations: 2,
                delay_ms: 0,
                stop_on_error: true,
                http_errors_fail: true,
                keep_variable_values: true,
                share_cookies: true,
                persist_responses: true,
                disable_logs: false,
                data_file_name: None,
            },
            plan: vec![
                RecordedPlanItem {
                    request_id: "r0".to_string(),
                    name: "Req <0>".to_string(),
                    protocol: "rest".to_string(),
                    method: "get".to_string(),
                },
                RecordedPlanItem {
                    request_id: "r1".to_string(),
                    name: "Consulta".to_string(),
                    protocol: "graphql".to_string(),
                    method: "post".to_string(),
                },
            ],
            steps: vec![
                step(0, 0, RecordedStepOutcome::Passed),
                step(0, 1, RecordedStepOutcome::Failed),
            ],
            outputs: vec![RecordedStepOutput {
                iteration: 0,
                position: 0,
                status_code: 200,
                duration_ms: 40,
                size_bytes: 11,
                headers: vec![("content-type".to_string(), "application/json".to_string())],
                body: "{\"ok\":true}".to_string(),
                base64: false,
                truncated: false,
            }],
        }
    }

    fn context(language: ReportLanguage) -> ReportContext {
        ReportContext {
            app_version: "0.3.0".to_string(),
            language,
        }
    }

    #[test]
    fn rows_complete_the_plan_with_skipped_requests() {
        let record = record();
        let rows = report_rows(&record);

        let outcomes: Vec<_> = rows.iter().map(|row| row.outcome).collect();
        assert_eq!(
            outcomes,
            vec![
                RowOutcome::Passed,
                RowOutcome::Failed,
                RowOutcome::Skipped,
                RowOutcome::Skipped
            ]
        );
        assert_eq!(rows[3].name(), "Consulta");
        assert_eq!(rows[3].method(), "GQL");
    }

    #[test]
    fn json_report_has_summary_iterations_and_responses() {
        let json: Value = serde_json::from_str(&render_report(
            &record(),
            ReportFormat::Json,
            &context(ReportLanguage::En),
        ))
        .unwrap();

        assert_eq!(json["scope"], "Loja & Cia");
        assert_eq!(json["environment"], "Dev");
        assert_eq!(json["status"], "stopped");
        assert_eq!(json["startedAt"], "2026-09-21T14:13:20.123Z");
        assert_eq!(json["durationMs"], 1500);
        assert_eq!(json["summary"]["requests"]["skipped"], 2);
        assert_eq!(json["summary"]["tests"]["failed"], 1);
        assert_eq!(
            json["iterations"][0]["results"][0]["response"]["body"],
            "{\"ok\":true}"
        );
        assert_eq!(json["iterations"][1]["results"][1]["outcome"], "skipped");
        assert_eq!(json["options"]["stopOnError"], true);
    }

    #[test]
    fn junit_report_marks_failures_and_skips_and_escapes() {
        let xml = render_report(&record(), ReportFormat::Junit, &context(ReportLanguage::En));

        assert!(xml.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"));
        assert!(xml.contains(
            "<testsuites name=\"Loja &amp; Cia\" tests=\"4\" failures=\"1\" errors=\"0\" skipped=\"2\" time=\"1.500\">"
        ));
        assert!(xml.contains("<testcase name=\"GET Req &lt;0&gt;\""));
        assert!(xml.contains("<failure message=\"status: esperado 200, recebido 404\">"));
        assert!(xml.contains("<skipped/>"));
        assert!(xml.contains("<system-out>log &lt;1&gt;</system-out>"));
    }

    #[test]
    fn html_report_is_self_contained_escaped_and_localized() {
        let html = render_report(
            &record(),
            ReportFormat::Html,
            &context(ReportLanguage::PtBr),
        );

        assert!(html.starts_with("<!DOCTYPE html>"));
        assert!(html.contains("<html lang=\"pt-BR\">"));
        // Nada carregado de fora: o arquivo abre offline.
        assert!(!html.contains("<script src"));
        assert!(!html.contains("<link"));
        assert!(html.contains("<h1>Loja &amp; Cia</h1>"));
        assert!(html.contains("Req &lt;0&gt;"));
        assert!(!html.contains("Req <0>"));
        assert!(html.contains("https://api.test/?a=1&amp;b=2"));
        assert!(html.contains("Puladas <b>2</b>"));
        assert!(html.contains("Interrompido"));
        assert!(html.contains("&quot;ok&quot;: true"));
        assert!(html.contains("Não executada"));
        assert!(html.contains("<h2>Iteração 2</h2>"));
    }

    #[test]
    fn iso_dates_are_utc() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_utc(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }
}
