use std::time::UNIX_EPOCH;

use alcy_collection_import::analyze_load_test;
use alcy_domain::{FlowNodeKind, LoadNodeKind};

#[test]
fn substantial_local_example_imports_without_diagnostics_or_missing_variables() {
    let source = include_str!("../../../examples/load-tests/substantial.k6.js");
    let analysis = analyze_load_test("substantial.k6.js", source, UNIX_EPOCH)
        .expect("the runnable example must remain compatible with the importer");
    assert!(analysis.required_variables.is_empty());
    assert_eq!(analysis.requests.len(), 12);
    assert!(
        analysis
            .requests
            .iter()
            .all(|request| request.url.starts_with("http://127.0.0.1:8787/"))
    );

    let configs = |kind| -> Vec<serde_json::Value> {
        analysis
            .flow
            .nodes()
            .iter()
            .filter_map(|node| match &node.kind {
                FlowNodeKind::Load { node } if node.kind == kind => {
                    Some(serde_json::from_str(&node.config).unwrap())
                }
                _ => None,
            })
            .collect()
    };
    let scenarios = configs(LoadNodeKind::Scenario);
    let phases: Vec<_> = scenarios
        .iter()
        .filter_map(|config| config["phase"].as_str())
        .collect();
    assert_eq!(phases, ["setup", "teardown"]);
    let scenarios: Vec<_> = scenarios
        .iter()
        .filter(|config| config.get("executor").is_some())
        .collect();
    assert_eq!(scenarios.len(), 2);
    assert_eq!(scenarios[0]["executor"], "rampingVus");
    assert_eq!(scenarios[0]["stages"][3]["target"], 100);
    assert_eq!(scenarios[1]["executor"], "constantArrivalRate");
    assert_eq!(scenarios[1]["rate"], 10);
    assert_eq!(configs(LoadNodeKind::Check).len(), 12);
    assert_eq!(configs(LoadNodeKind::Threshold).len(), 8);
    assert_eq!(configs(LoadNodeKind::Metric).len(), 2);
    assert_eq!(configs(LoadNodeKind::Timer).len(), 2);
    assert_eq!(
        analysis
            .requests
            .iter()
            .filter(|request| request.body.is_some())
            .count(),
        5
    );
}
