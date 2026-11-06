//! Decode portable flow documents without evaluating their contents.
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

/// Give each imported copy its own identity while retaining node IDs, which
/// are scoped to the graph and referenced by edges, templates and panels.
pub fn decode_flow_import(bytes: &[u8]) -> Result<Value, String> {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let document: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if document["format"].as_str() != Some("alcy-flow") {
        return Err("This file is not an Alcy flow export".into());
    }
    if document["version"].as_u64() != Some(1) {
        return Err("Unsupported Alcy flow export version".into());
    }
    let mut flow = document
        .get("flow")
        .filter(|v| v.is_object())
        .cloned()
        .ok_or("The export does not contain a flow")?;
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|e| e.to_string())?;
    let id: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let now = u64::try_from(now).map_err(|e| e.to_string())?;
    flow["id"] = json!(format!("flow-{id}"));
    flow["createdAtMs"] = json!(now);
    flow["updatedAtMs"] = json!(now);
    Ok(flow)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_imports_preserve_the_graph_with_independent_identities() {
        let graph = json!({"id":"original","name":"Example","nodes":[
            {"id":"call","kind":"request","requestId":"external"},
            {"id":"display","kind":"display","template":"{{nodes.call.response.body}}"}
        ],"edges":[{"sourceNodeId":"call","targetNodeId":"display"}],
            "presentation":{"panels":[{"nodeId":"display"}]}});
        let exported =
            crate::prepare_flow_export(graph.clone(), &crate::FlowExportContext::default(), false)
                .unwrap();
        let bytes = serde_json::to_vec(&exported.document).unwrap();
        let first = decode_flow_import(&bytes).unwrap();
        let second = decode_flow_import(&bytes).unwrap();
        assert_ne!(first["id"], graph["id"]);
        assert_ne!(first["id"], second["id"]);
        for field in ["nodes", "edges", "presentation", "name"] {
            assert_eq!(first[field], graph[field]);
        }
        assert!(first["createdAtMs"].as_u64().unwrap() > 0);
    }

    #[test]
    fn rejects_invalid_json_foreign_formats_and_unknown_versions() {
        for bytes in [
            b"{".as_slice(),
            br#"{"format":"alcy","version":1,"flow":{}}"#,
            br#"{"format":"alcy-flow","version":2,"flow":{}}"#,
            br#"{"format":"alcy-flow","version":1,"flow":null}"#,
        ] {
            assert!(decode_flow_import(bytes).is_err());
        }
    }
}
