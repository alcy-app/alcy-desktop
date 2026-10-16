//! Report gRPC resources skipped by the HTTP/GraphQL Insomnia importer.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::{CollectionImportError, FALLBACK_REQUEST_NAME, ImportWarning, check_depth, text_or};

fn warning(path: &[String]) -> ImportWarning {
    ImportWarning {
        request_path: path.join(" / "),
        phase: "request".into(),
        line: None,
        api: "grpc_request".into(),
        reason: "skippedProtocol".into(),
    }
}

pub(super) fn is_grpc(item: &Value) -> bool {
    item.get("_type").and_then(Value::as_str) == Some("grpc_request")
        || item.get("protoMethodName").is_some()
        || item.get("protoFileId").is_some()
        || item.get("reflectionApi").is_some()
        || item
            .pointer("/meta/id")
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with("greq_"))
}

pub(super) fn tree(root: &Value) -> Result<Vec<ImportWarning>, CollectionImportError> {
    fn visit(
        item: &Value,
        path: &mut Vec<String>,
        out: &mut Vec<ImportWarning>,
        depth: usize,
    ) -> Result<(), CollectionImportError> {
        check_depth(depth.saturating_sub(1))?;
        path.push(text_or(item.get("name"), FALLBACK_REQUEST_NAME).to_string());
        if let Some(children) = item
            .get("children")
            .or_else(|| item.get("collection"))
            .and_then(Value::as_array)
        {
            for child in children {
                visit(child, path, out, depth + 1)?;
            }
        } else if is_grpc(item) {
            out.push(warning(path));
        }
        path.pop();
        Ok(())
    }
    let mut warnings = Vec::new();
    visit(root, &mut Vec::new(), &mut warnings, 0)?;
    Ok(warnings)
}

pub(super) fn flat(resources: &[Value]) -> Vec<ImportWarning> {
    let by_id: HashMap<&str, &Value> = resources
        .iter()
        .filter_map(|item| item.get("_id").and_then(Value::as_str).map(|id| (id, item)))
        .collect();
    resources
        .iter()
        .filter(|item| is_grpc(item))
        .map(|item| {
            let mut path = vec![text_or(item.get("name"), FALLBACK_REQUEST_NAME).to_string()];
            let mut parent = item.get("parentId").and_then(Value::as_str);
            let mut seen = HashSet::new();
            while let Some(id) = parent {
                if !seen.insert(id) || path.len() > super::MAX_TREE_DEPTH {
                    break;
                }
                let Some(ancestor) = by_id.get(id) else {
                    break;
                };
                path.push(text_or(ancestor.get("name"), FALLBACK_REQUEST_NAME).to_string());
                parent = ancestor.get("parentId").and_then(Value::as_str);
            }
            path.reverse();
            warning(&path)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::parse_collection;

    #[test]
    fn reports_flat_grpc_resources_and_keeps_http_requests() {
        let imported = parse_collection(r#"{
          "__export_format":4,"resources":[
            {"_type":"workspace","_id":"w","name":"API"},
            {"_type":"request_group","_id":"f","parentId":"w","name":"Services"},
            {"_type":"grpc_request","_id":"g","parentId":"f","name":"Hello","url":"localhost:50051"},
            {"_type":"request","_id":"r","parentId":"f","name":"Ping","method":"GET","url":"https://api.test"}
          ]}"#).unwrap();
        assert_eq!(imported.collections[0].folders()[0].requests().len(), 1);
        assert_eq!(imported.warnings.len(), 1);
        let warning = &imported.warnings[0];
        assert_eq!(warning.request_path, "API / Services / Hello");
        assert_eq!(warning.api, "grpc_request");
        assert_eq!(warning.reason, "skippedProtocol");
        assert_eq!(warning.phase, "request");
    }

    #[test]
    fn reports_tree_grpc_requests_with_and_without_a_selected_method() {
        let imported = parse_collection(
            r#"
type: collection.insomnia.rest/5.0
name: API
collection:
  - name: Services
    children:
      - name: Hello
        meta: { id: greq_hello }
        protoMethodName: /test.Greeter/SayHello
        url: localhost:50051
      - name: Draft
        meta: { id: greq_draft }
        reflectionApi: { enabled: false }
        url: localhost:50051
      - name: Ping
        method: GET
        url: https://api.test
"#,
        )
        .unwrap();
        assert_eq!(imported.collections[0].folders()[0].requests().len(), 1);
        assert_eq!(
            imported
                .warnings
                .iter()
                .map(|warning| warning.request_path.as_str())
                .collect::<Vec<_>>(),
            ["API / Services / Hello", "API / Services / Draft"]
        );
    }
}
