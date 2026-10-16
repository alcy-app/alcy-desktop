//! Variable review of a prepared import (spec 0130): lists the variables an
//! import defines or references, and applies the person's choice of which
//! ones to keep, where, under which name and whether they are sensitive.

use std::collections::{HashMap, HashSet};

use alcy_domain::{
    Authentication, BodyPayload, Collection, Endpoint, Environment, EnvironmentError,
    EnvironmentVariable, Folder, FormDataFieldValue, HeaderEntry, Request, SavedRequest,
};

use crate::{CollectionImportError, ImportedCollectionData};

/// Values longer than this reach the review truncated and read-only, so a
/// large value (a certificate, a long token) does not cross the IPC whole.
pub const MAX_REVIEW_VALUE_BYTES: usize = 4096;

/// Where the import placed a variable before the review.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VariableOrigin {
    /// Index into `ImportedCollectionData::environments`.
    Environment(usize),
    /// Index into `ImportedCollectionData::collections` (root variables).
    Collection(usize),
    /// Used as `{{name}}` in the import but defined nowhere in it.
    Referenced,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportVariableCandidate {
    /// Stable within one prepared import: `env:{i}:{name}`,
    /// `collection:{i}:{name}` or `ref:{name}`.
    pub key: String,
    pub name: String,
    pub value: String,
    pub value_truncated: bool,
    /// Only what the file declares (`secret`, private environment); names
    /// are never taken as a hint.
    pub sensitive: bool,
    pub origin: VariableOrigin,
    /// Defined variables start included; referenced ones start excluded.
    pub included: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VariableTarget {
    ImportedEnvironment(usize),
    /// An environment created by the import, grouped by name.
    NewEnvironment(String),
    /// Id of an environment that already exists in the workspace.
    ExistingEnvironment(String),
    Collection(usize),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariableSelection {
    pub key: String,
    pub include: bool,
    pub name: String,
    /// `None` keeps the original value (always the case for truncated ones).
    pub value: Option<String>,
    pub sensitive: bool,
    pub target: VariableTarget,
}

/// Variables to upsert, by name, into an environment the workspace
/// already has. The frontend owns that state, so it applies the merge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvironmentMerge {
    pub environment_id: String,
    pub variables: Vec<EnvironmentVariable>,
}

pub fn variable_candidates(data: &ImportedCollectionData) -> Vec<ImportVariableCandidate> {
    let mut candidates = Vec::new();
    for (index, environment) in data.environments.iter().enumerate() {
        for variable in environment.variables() {
            candidates.push(defined_candidate(
                format!("env:{index}:{}", variable.name()),
                variable,
                VariableOrigin::Environment(index),
            ));
        }
    }
    for (index, collection) in data.collections.iter().enumerate() {
        for variable in collection.variables() {
            candidates.push(defined_candidate(
                format!("collection:{index}:{}", variable.name()),
                variable,
                VariableOrigin::Collection(index),
            ));
        }
    }
    for name in referenced_names(data) {
        candidates.push(ImportVariableCandidate {
            key: format!("ref:{name}"),
            sensitive: false,
            name,
            value: String::new(),
            value_truncated: false,
            origin: VariableOrigin::Referenced,
            included: false,
        });
    }
    candidates
}

fn defined_candidate(
    key: String,
    variable: &EnvironmentVariable,
    origin: VariableOrigin,
) -> ImportVariableCandidate {
    let (value, value_truncated) = review_value(variable.value());
    ImportVariableCandidate {
        key,
        name: variable.name().to_string(),
        value,
        value_truncated,
        sensitive: variable.sensitive,
        origin,
        included: true,
    }
}

fn review_value(value: &str) -> (String, bool) {
    if value.len() <= MAX_REVIEW_VALUE_BYTES {
        return (value.to_string(), false);
    }
    let mut end = MAX_REVIEW_VALUE_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_string(), true)
}

/// Names used as `{{name}}` that no environment, collection or folder of
/// the import defines, in order of first use.
fn referenced_names(data: &ImportedCollectionData) -> Vec<String> {
    let mut defined: HashSet<String> = HashSet::new();
    let mut texts: Vec<String> = Vec::new();
    for environment in &data.environments {
        collect_variables(environment.variables(), &mut defined, &mut texts);
    }
    for collection in &data.collections {
        collect_variables(collection.variables(), &mut defined, &mut texts);
        collect_auth_texts(&collection.authentication, &mut texts);
        collect_requests(collection.requests(), &mut texts);
        collect_folders(collection.folders(), &mut defined, &mut texts);
    }

    let mut seen = HashSet::new();
    let mut names = Vec::new();
    for text in &texts {
        for_each_placeholder(text, |name| {
            if is_reviewable_name(name) && !defined.contains(name) && seen.insert(name.to_string())
            {
                names.push(name.to_string());
            }
        });
    }
    names
}

fn collect_variables(
    variables: &[EnvironmentVariable],
    defined: &mut HashSet<String>,
    texts: &mut Vec<String>,
) {
    for variable in variables {
        defined.insert(variable.name().to_string());
        texts.push(variable.value().to_string());
    }
}

fn collect_folders(folders: &[Folder], defined: &mut HashSet<String>, texts: &mut Vec<String>) {
    for folder in folders {
        collect_variables(folder.variables(), defined, texts);
        collect_auth_texts(&folder.authentication, texts);
        collect_requests(folder.requests(), texts);
        collect_folders(folder.folders(), defined, texts);
    }
}

fn collect_requests(requests: &[SavedRequest], texts: &mut Vec<String>) {
    for saved in requests {
        // The walker mutates; one request at a time keeps the copy small.
        let mut request = saved.request.clone();
        for_each_request_text(&mut request, &mut |text| texts.push(text.clone()));
    }
}

fn collect_auth_texts(authentication: &Authentication, texts: &mut Vec<String>) {
    let mut authentication = authentication.clone();
    for_each_auth_text(&mut authentication, &mut |text| texts.push(text.clone()));
}

/// Dynamic (`$name`) and flow node (`nodes.*`) references are not variables.
fn is_reviewable_name(name: &str) -> bool {
    !name.starts_with('$')
        && !name.starts_with("nodes.")
        && EnvironmentVariable::new(name, "", false).is_ok()
}

/// Calls `visit` with the trimmed name of each `{{name}}`; an unclosed `{{`
/// is literal text, as in variable resolution.
fn for_each_placeholder(text: &str, mut visit: impl FnMut(&str)) {
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let after_open = &rest[start + 2..];
        let Some(end) = after_open.find("}}") else {
            return;
        };
        visit(after_open[..end].trim());
        rest = &after_open[end + 2..];
    }
}

/// Every text field of a request that variable resolution interpolates.
/// Scripts stay out: they read variables through the API, not placeholders.
fn for_each_request_text(request: &mut Request, visit: &mut impl FnMut(&mut String)) {
    let mut url = request.endpoint.url().to_string();
    visit(&mut url);
    request.endpoint = Endpoint::saved(url);

    for header in &mut request.headers {
        let mut name = header.name().to_string();
        let mut value = header.value().to_string();
        visit(&mut name);
        visit(&mut value);
        if let Ok(rewritten) = HeaderEntry::new(name, value, header.enabled) {
            *header = rewritten;
        }
    }

    visit(&mut request.document.body);
    visit(&mut request.variables);
    for_each_auth_text(&mut request.authentication, visit);
    match &mut request.body_payload {
        BodyPayload::UrlEncoded(fields) => {
            for field in fields {
                visit(&mut field.name);
                visit(&mut field.value);
            }
        }
        BodyPayload::FormData(fields) => {
            for field in fields {
                visit(&mut field.name);
                if let FormDataFieldValue::Text(value) = &mut field.value {
                    visit(value);
                }
            }
        }
        BodyPayload::None | BodyPayload::Raw { .. } | BodyPayload::Binary { .. } => {}
    }
    for parameter in &mut request.route_parameters {
        visit(&mut parameter.value);
    }
}

fn for_each_auth_text(authentication: &mut Authentication, visit: &mut impl FnMut(&mut String)) {
    match authentication {
        Authentication::None | Authentication::Inherit => {}
        Authentication::CustomHeader { name, value } => {
            visit(name);
            visit(value);
        }
        Authentication::Bearer { token } => visit(token),
        Authentication::Basic { username, password }
        | Authentication::Digest { username, password } => {
            visit(username);
            visit(password);
        }
        Authentication::OAuth2ClientCredentials {
            client_id,
            client_secret,
            token_url,
            scope,
        } => {
            visit(client_id);
            visit(client_secret);
            visit(token_url);
            visit(scope);
        }
    }
}

struct Source {
    name: String,
    value: String,
    candidate: ImportVariableCandidate,
}

/// Applies the review to the import. A candidate without a selection keeps
/// its default (defined: kept where it was; referenced: left out); unknown
/// keys are ignored. Renamed variables have their `{{old}}` references in
/// the imported requests rewritten.
pub fn apply_variable_selection(
    mut data: ImportedCollectionData,
    selections: &[VariableSelection],
) -> Result<(ImportedCollectionData, Vec<EnvironmentMerge>), CollectionImportError> {
    let sources = variable_sources(&data);
    let by_key: HashMap<&str, &VariableSelection> = selections
        .iter()
        .map(|selection| (selection.key.as_str(), selection))
        .collect();

    let mut imported: Vec<Vec<EnvironmentVariable>> = vec![Vec::new(); data.environments.len()];
    let mut collections: Vec<Vec<EnvironmentVariable>> = vec![Vec::new(); data.collections.len()];
    let mut created: Vec<(String, Vec<EnvironmentVariable>)> = Vec::new();
    let mut merges: Vec<EnvironmentMerge> = Vec::new();
    let mut renames: HashMap<String, String> = HashMap::new();

    for source in &sources {
        let selection = match by_key.get(source.candidate.key.as_str()) {
            Some(selection) => (*selection).clone(),
            None => default_selection(&source.candidate),
        };
        if !selection.include {
            continue;
        }
        let name = selection.name.trim().to_string();
        if name != source.name {
            match renames.get(&source.name) {
                Some(existing) if *existing != name => {
                    return Err(CollectionImportError::Invalid(format!(
                        "variável '{}' renomeada para nomes diferentes",
                        source.name
                    )));
                }
                _ => {
                    renames.insert(source.name.clone(), name.clone());
                }
            }
        }
        let value = selection.value.unwrap_or_else(|| source.value.clone());
        let variable = EnvironmentVariable::new(name, value, selection.sensitive)?;
        match selection.target {
            VariableTarget::ImportedEnvironment(index) => imported
                .get_mut(index)
                .ok_or_else(|| invalid_target("ambiente"))?
                .push(variable),
            VariableTarget::Collection(index) => collections
                .get_mut(index)
                .ok_or_else(|| invalid_target("coleção"))?
                .push(variable),
            VariableTarget::NewEnvironment(environment_name) => {
                let environment_name = environment_name.trim().to_string();
                match created
                    .iter_mut()
                    .find(|(existing, _)| *existing == environment_name)
                {
                    Some((_, variables)) => variables.push(variable),
                    None => created.push((environment_name, vec![variable])),
                }
            }
            VariableTarget::ExistingEnvironment(environment_id) => {
                match merges
                    .iter_mut()
                    .find(|merge| merge.environment_id == environment_id)
                {
                    Some(merge) => merge.variables.push(variable),
                    None => merges.push(EnvironmentMerge {
                        environment_id,
                        variables: vec![variable],
                    }),
                }
            }
        }
    }

    for variables in imported
        .iter_mut()
        .chain(collections.iter_mut())
        .chain(created.iter_mut().map(|(_, variables)| variables))
        .chain(merges.iter_mut().map(|merge| &mut merge.variables))
    {
        rewrite_variable_values(variables, &renames);
    }
    for merge in &merges {
        reject_duplicates(&merge.variables)?;
    }

    let mut environments = Vec::new();
    for (environment, variables) in data.environments.iter().zip(imported) {
        if !variables.is_empty() {
            environments.push(Environment::new(
                environment.id.clone(),
                environment.name(),
                variables,
            )?);
        }
    }
    for (index, (name, variables)) in created.into_iter().enumerate() {
        environments.push(Environment::new(
            format!("imported-environment-new-{}", index + 1),
            name,
            variables,
        )?);
    }
    data.environments = environments;

    data.collections = data
        .collections
        .into_iter()
        .zip(collections)
        .map(|(collection, variables)| {
            let collection = if renames.is_empty() {
                collection
            } else {
                rename_in_collection(collection, &renames)?
            };
            Ok(collection.with_variables(variables)?)
        })
        .collect::<Result<_, CollectionImportError>>()?;

    Ok((data, merges))
}

fn variable_sources(data: &ImportedCollectionData) -> Vec<Source> {
    let mut originals: HashMap<String, (String, String)> = HashMap::new();
    for (index, environment) in data.environments.iter().enumerate() {
        for variable in environment.variables() {
            originals.insert(
                format!("env:{index}:{}", variable.name()),
                (variable.name().to_string(), variable.value().to_string()),
            );
        }
    }
    for (index, collection) in data.collections.iter().enumerate() {
        for variable in collection.variables() {
            originals.insert(
                format!("collection:{index}:{}", variable.name()),
                (variable.name().to_string(), variable.value().to_string()),
            );
        }
    }
    variable_candidates(data)
        .into_iter()
        .map(|candidate| {
            let (name, value) = originals
                .remove(&candidate.key)
                .unwrap_or_else(|| (candidate.name.clone(), String::new()));
            Source {
                name,
                value,
                candidate,
            }
        })
        .collect()
}

fn default_selection(candidate: &ImportVariableCandidate) -> VariableSelection {
    VariableSelection {
        key: candidate.key.clone(),
        include: candidate.included,
        name: candidate.name.clone(),
        value: None,
        sensitive: candidate.sensitive,
        target: match candidate.origin {
            VariableOrigin::Environment(index) => VariableTarget::ImportedEnvironment(index),
            VariableOrigin::Collection(index) => VariableTarget::Collection(index),
            VariableOrigin::Referenced => VariableTarget::NewEnvironment(String::new()),
        },
    }
}

fn invalid_target(kind: &str) -> CollectionImportError {
    CollectionImportError::Invalid(format!("{kind} de destino inexistente na importação"))
}

fn reject_duplicates(variables: &[EnvironmentVariable]) -> Result<(), CollectionImportError> {
    let mut seen = HashSet::new();
    for variable in variables {
        if !seen.insert(variable.name()) {
            return Err(EnvironmentError::DuplicateVariable(variable.name().to_string()).into());
        }
    }
    Ok(())
}

/// Replaces `{{old}}` with `{{new}}` for each renamed name; every other
/// placeholder and all surrounding text stay byte for byte.
fn rename_placeholders(text: &mut String, renames: &HashMap<String, String>) {
    if renames.is_empty() || !text.contains("{{") {
        return;
    }
    let mut result = String::with_capacity(text.len());
    let mut rest = text.as_str();
    let mut changed = false;
    while let Some(start) = rest.find("{{") {
        let after_open = &rest[start + 2..];
        let Some(end) = after_open.find("}}") else {
            break;
        };
        result.push_str(&rest[..start]);
        match renames.get(after_open[..end].trim()) {
            Some(new_name) => {
                result.push_str("{{");
                result.push_str(new_name);
                result.push_str("}}");
                changed = true;
            }
            None => result.push_str(&rest[start..start + 2 + end + 2]),
        }
        rest = &after_open[end + 2..];
    }
    if changed {
        result.push_str(rest);
        *text = result;
    }
}

fn rewrite_variable_values(
    variables: &mut [EnvironmentVariable],
    renames: &HashMap<String, String>,
) {
    if renames.is_empty() {
        return;
    }
    for variable in variables.iter_mut() {
        let mut value = variable.value().to_string();
        rename_placeholders(&mut value, renames);
        if value != variable.value()
            && let Ok(rewritten) =
                EnvironmentVariable::new(variable.name(), value, variable.sensitive)
        {
            *variable = rewritten;
        }
    }
}

fn rename_in_collection(
    collection: Collection,
    renames: &HashMap<String, String>,
) -> Result<Collection, CollectionImportError> {
    let mut authentication = collection.authentication.clone();
    for_each_auth_text(&mut authentication, &mut |text| {
        rename_placeholders(text, renames)
    });
    let folders = collection
        .folders()
        .iter()
        .map(|folder| rename_in_folder(folder, renames))
        .collect::<Result<Vec<_>, _>>()?;
    let renamed = Collection::new(
        collection.id.clone(),
        collection.name(),
        folders,
        rename_in_requests(collection.requests(), renames),
    )?
    .with_authentication(authentication)
    .with_labels(collection.labels().to_vec())?;
    Ok(renamed)
}

/// Folder variables keep their scope, but share the rename: a folder that
/// shadows `{{old}}` keeps shadowing it under the new name.
fn rename_in_folder(
    folder: &Folder,
    renames: &HashMap<String, String>,
) -> Result<Folder, CollectionImportError> {
    let mut authentication = folder.authentication.clone();
    for_each_auth_text(&mut authentication, &mut |text| {
        rename_placeholders(text, renames)
    });
    let folders = folder
        .folders()
        .iter()
        .map(|child| rename_in_folder(child, renames))
        .collect::<Result<Vec<_>, _>>()?;
    let mut variables = Vec::with_capacity(folder.variables().len());
    for variable in folder.variables() {
        let name = renames
            .get(variable.name())
            .map_or(variable.name(), String::as_str);
        let mut value = variable.value().to_string();
        rename_placeholders(&mut value, renames);
        variables.push(EnvironmentVariable::new(name, value, false)?);
    }
    Ok(Folder::new(
        folder.id.clone(),
        folder.name(),
        folders,
        rename_in_requests(folder.requests(), renames),
    )?
    .with_authentication(authentication)
    .with_variables(variables)?)
}

fn rename_in_requests(
    requests: &[SavedRequest],
    renames: &HashMap<String, String>,
) -> Vec<SavedRequest> {
    requests
        .iter()
        .map(|saved| {
            let mut saved = saved.clone();
            for_each_request_text(&mut saved.request, &mut |text| {
                rename_placeholders(text, renames)
            });
            saved
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse_collection;

    const POSTMAN: &str = r#"{
      "info": {"name": "Customer API", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
      "auth": {"type": "bearer", "bearer": [{"key": "token", "value": "{{token}}"}]},
      "variable": [
        {"key": "baseUrl", "value": "https://api.example.com"},
        {"key": "token", "value": "abc"}
      ],
      "item": [
        {"name": "Users", "variable": [{"key": "page", "value": "{{baseUrl}}/p"}], "item": [
          {"name": "List users", "request": {
            "method": "GET",
            "url": "{{baseUrl}}/users?tenant={{ tenant }}&id={{$guid}}",
            "header": [{"key": "X-Key", "value": "{{apiKey}}"}],
            "body": {"mode": "raw", "raw": "{\"page\": \"{{page}}\", \"node\": \"{{nodes.a.body}}\"}"}
          }}
        ]}
      ]
    }"#;

    fn candidate<'a>(
        candidates: &'a [ImportVariableCandidate],
        key: &str,
    ) -> &'a ImportVariableCandidate {
        candidates
            .iter()
            .find(|candidate| candidate.key == key)
            .unwrap()
    }

    fn select(key: &str, name: &str, target: VariableTarget) -> VariableSelection {
        VariableSelection {
            key: key.to_string(),
            include: true,
            name: name.to_string(),
            value: None,
            sensitive: false,
            target,
        }
    }

    fn first_request(data: &ImportedCollectionData) -> &Request {
        &data.collections[0].folders()[0].requests()[0].request
    }

    #[test]
    fn lists_collection_variables_and_undefined_references() {
        let data = parse_collection(POSTMAN).unwrap();

        let candidates = variable_candidates(&data);
        let keys: Vec<&str> = candidates
            .iter()
            .map(|candidate| candidate.key.as_str())
            .collect();

        assert_eq!(
            keys,
            [
                "collection:0:baseUrl",
                "collection:0:token",
                "ref:tenant",
                "ref:apiKey"
            ]
        );
        let token = candidate(&candidates, "collection:0:token");
        // Names are never a hint: only a flag in the file marks a variable sensitive.
        assert!(!token.sensitive && token.included);
        assert_eq!(token.origin, VariableOrigin::Collection(0));
        let api_key = candidate(&candidates, "ref:apiKey");
        assert!(!api_key.sensitive && !api_key.included);
        assert_eq!(api_key.value, "");
    }

    #[test]
    fn keeps_secret_flags_from_an_environment_export() {
        let data = parse_collection(
            r#"{"name": "Production", "_postman_variable_scope": "environment", "values": [
              {"key": "host", "value": "h", "enabled": true},
              {"key": "pin", "value": "1", "enabled": true, "type": "secret"}
            ]}"#,
        )
        .unwrap();

        let candidates = variable_candidates(&data);

        assert_eq!(candidates.len(), 2);
        assert!(!candidate(&candidates, "env:0:host").sensitive);
        assert!(candidate(&candidates, "env:0:pin").sensitive);
        assert_eq!(
            candidate(&candidates, "env:0:pin").origin,
            VariableOrigin::Environment(0)
        );
    }

    #[test]
    fn truncates_long_values_on_a_char_boundary() {
        let (value, truncated) = review_value(&"é".repeat(MAX_REVIEW_VALUE_BYTES));

        assert!(truncated);
        assert!(value.len() <= MAX_REVIEW_VALUE_BYTES);
        assert_eq!(review_value("short"), ("short".to_string(), false));
    }

    #[test]
    fn no_selection_keeps_the_import_as_it_was() {
        let data = parse_collection(POSTMAN).unwrap();

        let (applied, merges) = apply_variable_selection(data.clone(), &[]).unwrap();

        assert_eq!(applied, data);
        assert!(merges.is_empty());
    }

    #[test]
    fn excludes_moves_and_creates_variables() {
        let data = parse_collection(POSTMAN).unwrap();
        let mut token = select(
            "collection:0:token",
            "token",
            VariableTarget::NewEnvironment("Dev".to_string()),
        );
        token.sensitive = true;
        let mut tenant = select("ref:tenant", "tenant", VariableTarget::Collection(0));
        tenant.value = Some("acme".to_string());
        let api_key = select(
            "ref:apiKey",
            "apiKey",
            VariableTarget::ExistingEnvironment("env-1".to_string()),
        );
        let mut base_url = select(
            "collection:0:baseUrl",
            "baseUrl",
            VariableTarget::Collection(0),
        );
        base_url.include = false;

        let (applied, merges) =
            apply_variable_selection(data, &[token, tenant, api_key, base_url]).unwrap();

        let collection_variables = applied.collections[0].variables();
        assert_eq!(collection_variables.len(), 1);
        assert_eq!(collection_variables[0].name(), "tenant");
        assert_eq!(collection_variables[0].value(), "acme");
        assert_eq!(applied.environments.len(), 1);
        assert_eq!(applied.environments[0].name(), "Dev");
        assert_eq!(applied.environments[0].variables()[0].value(), "abc");
        assert!(applied.environments[0].variables()[0].sensitive);
        assert_eq!(merges.len(), 1);
        assert_eq!(merges[0].environment_id, "env-1");
        assert_eq!(merges[0].variables[0].name(), "apiKey");
    }

    #[test]
    fn moving_to_a_collection_drops_the_sensitive_flag() {
        let data = parse_collection(
            r#"{"name": "Production", "_postman_variable_scope": "environment", "values": [
              {"key": "pin", "value": "1", "enabled": true, "type": "secret"}
            ]}"#,
        )
        .unwrap();
        let data = ImportedCollectionData {
            collections: parse_collection(POSTMAN).unwrap().collections,
            ..data
        };
        let mut pin = select("env:0:pin", "pin", VariableTarget::Collection(0));
        pin.sensitive = true;

        let (applied, _) = apply_variable_selection(data, &[pin]).unwrap();

        assert!(applied.environments.is_empty());
        let moved = applied.collections[0]
            .variables()
            .iter()
            .find(|variable| variable.name() == "pin")
            .unwrap();
        assert!(!moved.sensitive);
    }

    #[test]
    fn renaming_rewrites_references_across_the_import() {
        let data = parse_collection(POSTMAN).unwrap();
        let base_url = select(
            "collection:0:baseUrl",
            "host",
            VariableTarget::Collection(0),
        );
        let token = select(
            "collection:0:token",
            "apiToken",
            VariableTarget::Collection(0),
        );
        let tenant = select("ref:tenant", "org", VariableTarget::Collection(0));

        let (applied, _) = apply_variable_selection(data, &[base_url, token, tenant]).unwrap();

        let request = first_request(&applied);
        assert_eq!(
            request.endpoint.url(),
            "{{host}}/users?tenant={{org}}&id={{$guid}}"
        );
        assert_eq!(request.headers[0].value(), "{{apiKey}}");
        assert!(request.document.body.contains("{{nodes.a.body}}"));
        assert_eq!(
            request.authentication,
            Authentication::Bearer {
                token: "{{apiToken}}".to_string()
            }
        );
        let folder_variable = &applied.collections[0].folders()[0].variables()[0];
        assert_eq!(folder_variable.value(), "{{host}}/p");
        assert_eq!(applied.collections[0].variables()[0].name(), "host");
    }

    #[test]
    fn renaming_a_folder_shadowed_name_renames_the_folder_variable_too() {
        let data = parse_collection(POSTMAN).unwrap();
        let data = ImportedCollectionData {
            environments: vec![
                Environment::new(
                    "e",
                    "Dev",
                    vec![EnvironmentVariable::new("page", "1", false).unwrap()],
                )
                .unwrap(),
            ],
            ..data
        };
        let page = select(
            "env:0:page",
            "pageUrl",
            VariableTarget::ImportedEnvironment(0),
        );

        let (applied, _) = apply_variable_selection(data, &[page]).unwrap();

        assert_eq!(
            applied.collections[0].folders()[0].variables()[0].name(),
            "pageUrl"
        );
        assert!(
            first_request(&applied)
                .document
                .body
                .contains("{{pageUrl}}")
        );
    }

    #[test]
    fn rejects_duplicates_and_conflicting_renames() {
        let data = parse_collection(POSTMAN).unwrap();
        let base_url = select(
            "collection:0:baseUrl",
            "same",
            VariableTarget::Collection(0),
        );
        let token = select("collection:0:token", "same", VariableTarget::Collection(0));
        assert!(apply_variable_selection(data.clone(), &[base_url, token]).is_err());

        let first = select(
            "collection:0:token",
            "a",
            VariableTarget::ExistingEnvironment("x".to_string()),
        );
        let second = select(
            "ref:apiKey",
            "a",
            VariableTarget::ExistingEnvironment("x".to_string()),
        );
        assert!(apply_variable_selection(data.clone(), &[first, second]).is_err());

        let environments = vec![
            Environment::new(
                "e1",
                "Dev",
                vec![EnvironmentVariable::new("host", "1", false).unwrap()],
            )
            .unwrap(),
            Environment::new(
                "e2",
                "Prod",
                vec![EnvironmentVariable::new("host", "2", false).unwrap()],
            )
            .unwrap(),
        ];
        let data = ImportedCollectionData {
            environments,
            ..data
        };
        let dev = select("env:0:host", "a", VariableTarget::ImportedEnvironment(0));
        let prod = select("env:1:host", "b", VariableTarget::ImportedEnvironment(1));
        assert!(apply_variable_selection(data, &[dev, prod]).is_err());
    }

    #[test]
    fn rejects_an_out_of_range_target() {
        let data = parse_collection(POSTMAN).unwrap();
        let token = select("collection:0:token", "token", VariableTarget::Collection(3));

        assert!(apply_variable_selection(data, &[token]).is_err());
    }

    #[test]
    fn placeholders_rename_without_touching_other_text() {
        let renames = HashMap::from([("a".to_string(), "b".to_string())]);
        let mut text = "x {{ a }} {{c}} {{a".to_string();

        rename_placeholders(&mut text, &renames);

        assert_eq!(text, "x {{b}} {{c}} {{a");
    }
}
