//! Form validation, immutable result snapshots and the human-interaction port.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::io::{Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use alcy_domain::{FlowForm, FlowFormField, FlowFormFieldKind};
use serde_json::{Map, Value};

use crate::node_reference::NodeRunHistory;

pub type FormAnswers = Map<String, Value>;

#[derive(Debug, Clone)]
pub struct PreparedFlowForm {
    pub form: FlowForm,
    /// Actual values remain native; the UI receives only projected pages.
    pub sources: HashMap<String, Arc<Vec<Value>>>,
}

pub trait FlowHumanInteraction: Sync {
    fn request_input(
        &self,
        node_id: &str,
        form: PreparedFlowForm,
    ) -> impl Future<Output = Result<FormAnswers, String>> + Send;
}

pub struct NoHumanInteraction;

impl FlowHumanInteraction for NoHumanInteraction {
    async fn request_input(
        &self,
        _node_id: &str,
        _form: PreparedFlowForm,
    ) -> Result<FormAnswers, String> {
        Err("Human interaction is unavailable in this execution context".into())
    }
}

pub fn validate_form_definition(form: &FlowForm, allow_results: bool) -> Result<(), String> {
    if form.sections.len() > 50 || form.title.len() > 1024 || form.description.len() > 4096 {
        return Err("Form definition exceeds its limits".into());
    }
    let mut ids = HashSet::new();
    let mut sections = HashSet::new();
    for section in &form.sections {
        if !valid_id(&section.id) || !sections.insert(&section.id) || section.title.len() > 1024 {
            return Err("Each section needs a unique identifier and a short title".into());
        }
        for field in &section.fields {
            if !valid_id(&field.id) || !ids.insert(&field.id) || ids.len() > 200 {
                return Err(
                    "Each field needs a unique identifier (letters, numbers and underscores)"
                        .into(),
                );
            }
            if field.label.trim().is_empty()
                || field.label.len() > 1024
                || field.description.len() > 4096
                || field.initial_value.len() > 8192
            {
                return Err(format!(
                    "{}: invalid label, description or initial value",
                    field.id
                ));
            }
            if field.kind == FlowFormFieldKind::Number
                && (field
                    .min
                    .into_iter()
                    .chain(field.max)
                    .chain(field.step)
                    .any(|v| !v.is_finite())
                    || matches!((field.min, field.max), (Some(min), Some(max)) if min > max)
                    || field.step.is_some_and(|step| step <= 0.0))
            {
                return Err(format!("{}: invalid numeric limits", field.id));
            }
            if matches!(
                field.kind,
                FlowFormFieldKind::Select | FlowFormFieldKind::Radio
            ) {
                let mut options = HashSet::new();
                if field.options.is_empty()
                    || field.options.len() > 200
                    || field.options.iter().any(|option| {
                        option.value.is_empty()
                            || option.value.len() > 1024
                            || option.label.len() > 1024
                            || !options.insert(&option.value)
                    })
                {
                    return Err(format!(
                        "{}: options need unique, nonempty values",
                        field.id
                    ));
                }
            }
            if field.kind == FlowFormFieldKind::Result {
                let source = field
                    .source
                    .as_ref()
                    .ok_or_else(|| format!("{}: choose a result source", field.id))?;
                if !allow_results
                    || source.reference.len() > 4096
                    || source.columns.is_empty()
                    || source.columns.len() > 10
                    || source
                        .columns
                        .iter()
                        .any(|c| c.path.len() > 1024 || c.label.len() > 1024)
                {
                    return Err(format!("{}: invalid result source or columns", field.id));
                }
            }
        }
    }
    Ok(())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
        && !id.as_bytes()[0].is_ascii_digit()
}

pub fn prepare_flow_form(
    form: &FlowForm,
    history: &NodeRunHistory,
    ancestors: &HashSet<String>,
    cancelled: &AtomicBool,
) -> Result<PreparedFlowForm, String> {
    validate_form_definition(form, true)?;
    let mut sources = HashMap::new();
    let mut bytes = 0;
    let mut snapshot_bytes = 0;
    for field in form.sections.iter().flat_map(|section| &section.fields) {
        if field.kind != FlowFormFieldKind::Result {
            continue;
        }
        let source = field.source.as_ref().ok_or("Missing result source")?;
        let reference = source
            .reference
            .trim()
            .trim_start_matches("{{")
            .trim_end_matches("}}")
            .trim();
        if !reference.starts_with("nodes.") {
            return Err("Result source must reference a previous node".into());
        }
        let (node_id, path) = reference
            .strip_prefix("nodes.")
            .and_then(|r| r.split_once('.'))
            .ok_or("Invalid result reference")?;
        if !ancestors.contains(node_id) {
            return Err("Result source must be an ancestor".into());
        }
        let parsed;
        let (root, path) = if let Some(path) = path.strip_prefix("form.") {
            (
                history
                    .form_value(node_id)
                    .ok_or("Form result unavailable")?,
                path,
            )
        } else {
            let (body, path) = if let Some(path) = path.strip_prefix("response.body") {
                (history.get(node_id).map(|r| r.body.as_str()), path)
            } else if let Some(path) = path.strip_prefix("request.body") {
                (history.request_body(node_id), path)
            } else {
                return Err(
                    "Choose an array in a previous response, captured request or form".into(),
                );
            };
            if !path.is_empty() && !path.starts_with('.') {
                return Err("Invalid result path".into());
            }
            let body = body.ok_or("Result source unavailable")?;
            bytes += body.len();
            if bytes > 64 * 1024 * 1024 {
                return Err("Result sources exceed the 64 MiB snapshot limit".into());
            }
            parsed = serde_json::from_reader::<_, Value>(CancellableReader {
                remaining: body.as_bytes(),
                cancelled,
            })
            .map_err(|_| "Result source is not valid JSON or was cancelled")?;
            (&parsed, path.trim_start_matches('.'))
        };
        let mut value = root;
        for segment in path.split('.').filter(|s| !s.is_empty()) {
            if cancelled.load(Ordering::Relaxed) {
                return Err("Cancelled".into());
            }
            value = if let Some(array) = value.as_array() {
                segment.parse::<usize>().ok().and_then(|i| array.get(i))
            } else {
                value.get(segment)
            }
            .ok_or("Result path unavailable")?;
        }
        let values = value
            .as_array()
            .ok_or_else(|| format!("{}: source must be a JSON array", field.id))?;
        if values.len() > 100_000 {
            return Err("Result source exceeds 100,000 items".into());
        }
        serde_json::to_writer(
            SnapshotBudget {
                bytes: &mut snapshot_bytes,
                cancelled,
            },
            values,
        )
        .map_err(|_| "Result sources exceed the snapshot limit or were cancelled")?;
        sources.insert(field.id.clone(), Arc::new(values.clone()));
    }
    Ok(PreparedFlowForm {
        form: form.clone(),
        sources,
    })
}

struct CancellableReader<'a> {
    remaining: &'a [u8],
    cancelled: &'a AtomicBool,
}
impl Read for CancellableReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(std::io::Error::other("Cancelled"));
        }
        self.remaining.read(buffer)
    }
}

struct SnapshotBudget<'a> {
    bytes: &'a mut usize,
    cancelled: &'a AtomicBool,
}
impl Write for SnapshotBudget<'_> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        *self.bytes += buffer.len();
        if *self.bytes > 64 * 1024 * 1024 || self.cancelled.load(Ordering::Relaxed) {
            return Err(std::io::Error::other("Snapshot limit or cancellation"));
        }
        Ok(buffer.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormOptionPage {
    pub rows: Vec<FormOptionRow>,
    pub total: usize,
    pub next_offset: Option<usize>,
}

#[derive(Debug, serde::Serialize)]
pub struct FormOptionRow {
    pub index: usize,
    pub cells: Vec<String>,
}

impl PreparedFlowForm {
    pub fn option_page(&self, field_id: &str, offset: usize) -> Result<FormOptionPage, String> {
        let field = self
            .form
            .sections
            .iter()
            .flat_map(|s| &s.fields)
            .find(|f| f.id == field_id)
            .ok_or("invalidField")?;
        let source = self.sources.get(field_id).ok_or("invalidField")?;
        let columns = &field.source.as_ref().ok_or("invalidField")?.columns;
        if offset > source.len() {
            return Err("invalidOffset".into());
        }
        let mut rows = Vec::new();
        let mut bytes = 0;
        for (index, value) in source.iter().enumerate().skip(offset).take(100) {
            let cells = columns
                .iter()
                .map(|column| {
                    let mut cell = Some(value);
                    for part in column.path.split('.').filter(|p| !p.is_empty()) {
                        cell = cell.and_then(|v| {
                            if let Some(a) = v.as_array() {
                                part.parse::<usize>().ok().and_then(|i| a.get(i))
                            } else {
                                v.get(part)
                            }
                        });
                    }
                    match cell {
                        Some(Value::String(s)) => s.chars().take(256).collect::<String>(),
                        Some(Value::Array(_)) => "[…]".into(),
                        Some(Value::Object(_)) => "{…}".into(),
                        Some(v) => v.to_string(),
                        None => String::new(),
                    }
                })
                .collect::<Vec<_>>();
            let row = FormOptionRow { index, cells };
            let size = serde_json::to_vec(&row).map_err(|_| "unavailable")?.len();
            if bytes + size > 60 * 1024 {
                break;
            }
            bytes += size;
            rows.push(row);
        }
        let next = offset + rows.len();
        Ok(FormOptionPage {
            rows,
            total: source.len(),
            next_offset: (next < source.len()).then_some(next),
        })
    }

    pub fn validate_answers(&self, answers: &FormAnswers) -> Result<FormAnswers, String> {
        if serde_json::to_vec(answers)
            .map_err(|e| e.to_string())?
            .len()
            > 64 * 1024
        {
            return Err("Form answers exceed 64 KiB".into());
        }
        let fields: Vec<_> = self.form.sections.iter().flat_map(|s| &s.fields).collect();
        if answers.keys().any(|id| !fields.iter().any(|f| &f.id == id)) {
            return Err("Unknown form field".into());
        }
        let mut result = Map::new();
        for field in fields {
            let value = answers.get(&field.id).cloned().unwrap_or(Value::Null);
            if value.is_null() || value.as_str().is_some_and(|s| s.trim().is_empty()) {
                if field.required {
                    return Err(format!("{}: required", field.id));
                }
                result.insert(field.id.clone(), Value::Null);
                continue;
            }
            let value = self.validate_field(field, value)?;
            result.insert(field.id.clone(), value);
        }
        Ok(result)
    }

    fn validate_field(&self, field: &FlowFormField, value: Value) -> Result<Value, String> {
        let invalid = || format!("{}: invalid value", field.id);
        match field.kind {
            FlowFormFieldKind::Text | FlowFormFieldKind::Textarea => {
                if value.as_str().is_none_or(|s| s.len() > 8192) {
                    return Err(invalid());
                }
            }
            FlowFormFieldKind::Number => {
                let n = value.as_f64().ok_or_else(invalid)?;
                if !n.is_finite()
                    || field.min.is_some_and(|min| n < min)
                    || field.max.is_some_and(|max| n > max)
                {
                    return Err(invalid());
                }
                if let Some(step) = field.step {
                    let count = (n - field.min.unwrap_or(0.0)) / step;
                    if (count - count.round()).abs() > 1e-8 {
                        return Err(invalid());
                    }
                }
            }
            FlowFormFieldKind::Checkbox => {
                if !value.is_boolean() || (field.required && value != Value::Bool(true)) {
                    return Err(invalid());
                }
            }
            FlowFormFieldKind::Select | FlowFormFieldKind::Radio => {
                if !value
                    .as_str()
                    .is_some_and(|s| field.options.iter().any(|o| o.value == s))
                {
                    return Err(invalid());
                }
            }
            FlowFormFieldKind::Result => {
                let source = self.sources.get(&field.id).ok_or_else(invalid)?;
                let indices = if field.multiple {
                    value.as_array().cloned().ok_or_else(invalid)?
                } else {
                    vec![value]
                };
                if indices.len() > 1000 || (field.required && indices.is_empty()) {
                    return Err(invalid());
                }
                let mut seen = HashSet::new();
                let mut selected = Vec::new();
                for index in indices {
                    let index = index
                        .as_u64()
                        .and_then(|i| usize::try_from(i).ok())
                        .ok_or_else(invalid)?;
                    if !seen.insert(index) {
                        return Err(invalid());
                    }
                    selected.push(source.get(index).ok_or_else(invalid)?.clone());
                }
                return if field.multiple {
                    Ok(Value::Array(selected))
                } else {
                    selected.pop().ok_or_else(invalid)
                };
            }
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_domain::{
        FlowFormColumn, FlowFormSection, FlowFormSource, Response, ResponseMetadata,
    };
    use serde_json::json;

    fn form(field: FlowFormField) -> FlowForm {
        FlowForm {
            sections: vec![FlowFormSection {
                id: "main".into(),
                fields: vec![field],
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    fn field(kind: FlowFormFieldKind) -> FlowFormField {
        FlowFormField {
            id: "value".into(),
            label: "Value".into(),
            kind,
            ..Default::default()
        }
    }

    fn answers(value: Value) -> FormAnswers {
        Map::from_iter([("value".into(), value)])
    }

    fn result_form() -> FlowForm {
        let mut field = field(FlowFormFieldKind::Result);
        field.multiple = true;
        field.required = true;
        field.source = Some(FlowFormSource {
            view: Default::default(),
            reference: "{{nodes.fetch.response.body.items}}".into(),
            columns: vec![
                FlowFormColumn {
                    path: "id".into(),
                    label: "ID".into(),
                },
                FlowFormColumn {
                    path: "name".into(),
                    label: "Name".into(),
                },
            ],
        });
        form(field)
    }

    fn history(items: Value) -> NodeRunHistory {
        let mut history = NodeRunHistory::new();
        history.record(
            "fetch".into(),
            Response::new(
                200,
                0,
                json!({"items": items}).to_string(),
                vec![],
                ResponseMetadata::default(),
            ),
        );
        history
    }

    #[test]
    fn validates_types_required_values_numeric_bounds_and_steps() {
        let mut field = field(FlowFormFieldKind::Number);
        field.required = true;
        field.min = Some(1.0);
        field.max = Some(5.0);
        field.step = Some(2.0);
        let prepared = PreparedFlowForm {
            form: form(field),
            sources: HashMap::new(),
        };
        assert!(prepared.validate_answers(&answers(json!(3))).is_ok());
        for value in [json!("3"), json!(2), json!(7), Value::Null] {
            assert!(prepared.validate_answers(&answers(value)).is_err());
        }
        let prepared = PreparedFlowForm {
            form: form(FlowFormField {
                required: true,
                ..self::field(FlowFormFieldKind::Checkbox)
            }),
            sources: HashMap::new(),
        };
        assert!(prepared.validate_answers(&answers(json!(false))).is_err());
        assert!(prepared.validate_answers(&answers(json!(true))).is_ok());
    }

    #[test]
    fn rejects_duplicate_identifiers_and_results_in_start_forms() {
        let mut form = result_form();
        assert!(validate_form_definition(&form, false).is_err());
        let copy = form.sections[0].fields[0].clone();
        form.sections[0].fields.push(copy);
        assert!(validate_form_definition(&form, true).is_err());
    }

    #[test]
    fn pages_projected_options_and_resolves_indices_to_original_values() {
        let items: Vec<_> = (0..205)
            .map(|id| json!({"id":id,"name":format!("Item {id}"),"privatePayload":"native only"}))
            .collect();
        let history = history(json!(items));
        let prepared = prepare_flow_form(
            &result_form(),
            &history,
            &HashSet::from(["fetch".into()]),
            &AtomicBool::new(false),
        )
        .unwrap();
        let first = prepared.option_page("value", 0).unwrap();
        assert_eq!(first.rows.len(), 100);
        assert_eq!(first.next_offset, Some(100));
        assert_eq!(first.rows[0].cells, vec!["0", "Item 0"]);
        assert!(
            !serde_json::to_string(&first)
                .unwrap()
                .contains("privatePayload")
        );
        let last = prepared.option_page("value", 200).unwrap();
        assert_eq!(last.rows.len(), 5);
        assert_eq!(last.next_offset, None);
        let selected = prepared
            .validate_answers(&answers(json!([0, 204])))
            .unwrap();
        assert_eq!(selected["value"][1]["privatePayload"], "native only");
        assert!(prepared.validate_answers(&answers(json!([0, 0]))).is_err());
        assert!(prepared.validate_answers(&answers(json!([205]))).is_err());
        assert!(prepared.validate_answers(&answers(json!([]))).is_err());
        assert!(
            prepared
                .validate_answers(&answers(json!([{"id":0}])))
                .is_err()
        );
    }

    #[test]
    fn enforces_ancestry_cancellation_and_immutable_sources() {
        let mut history = history(json!([{"id":1}]));
        let ancestors = HashSet::from(["fetch".into()]);
        let definition = result_form();
        assert!(
            prepare_flow_form(
                &definition,
                &history,
                &HashSet::new(),
                &AtomicBool::new(false)
            )
            .is_err()
        );
        assert!(
            prepare_flow_form(&definition, &history, &ancestors, &AtomicBool::new(true)).is_err()
        );
        let prepared =
            prepare_flow_form(&definition, &history, &ancestors, &AtomicBool::new(false)).unwrap();
        history.record(
            "fetch".into(),
            Response::new(
                200,
                0,
                "{\"items\":[]}",
                vec![],
                ResponseMetadata::default(),
            ),
        );
        assert_eq!(
            prepared.validate_answers(&answers(json!([0]))).unwrap()["value"][0]["id"],
            1
        );
    }

    #[test]
    fn bounds_ipc_pages_even_with_escaped_unicode_cells() {
        let columns = (0..10)
            .map(|_| FlowFormColumn {
                path: "name".into(),
                label: "Name".into(),
            })
            .collect();
        let mut definition = result_form();
        definition.sections[0].fields[0]
            .source
            .as_mut()
            .unwrap()
            .columns = columns;
        let items = vec![json!({"name":"\u{0001}😀".repeat(256)}); 150];
        let prepared = prepare_flow_form(
            &definition,
            &history(json!(items)),
            &HashSet::from(["fetch".into()]),
            &AtomicBool::new(false),
        )
        .unwrap();
        let page = prepared.option_page("value", 0).unwrap();
        assert!(!page.rows.is_empty());
        assert!(page.rows.len() < 100);
        assert!(serde_json::to_vec(&page).unwrap().len() < 64 * 1024);
        assert_eq!(page.next_offset, Some(page.rows.len()));
    }
}
