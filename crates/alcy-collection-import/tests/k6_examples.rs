use std::collections::{HashSet, VecDeque};
use std::time::UNIX_EPOCH;

use alcy_collection_import::analyze_load_test;
use alcy_domain::{FlowNodeKind, LoadNodeKind};

fn assert_connected_global_thresholds(flow: &alcy_domain::Flow) {
    let scenarios: HashSet<_> = flow
        .nodes()
        .iter()
        .filter_map(|node| match &node.kind {
            FlowNodeKind::Load { node: load } if load.kind == LoadNodeKind::Scenario => {
                let config: serde_json::Value = serde_json::from_str(&load.config).unwrap();
                config.get("executor").is_some().then_some(node.id.as_str())
            }
            _ => None,
        })
        .collect();
    for node in flow.nodes().iter().filter(|node| matches!(&node.kind, FlowNodeKind::Load { node } if node.kind == LoadNodeKind::Threshold)) {
        let incoming: Vec<_> = flow.edges().iter().filter(|edge| edge.target_node_id == node.id).collect();
        assert_eq!(incoming.len(), scenarios.len(), "each threshold must join all scenarios");
        assert_eq!(incoming.iter().map(|edge| edge.source_node_id.as_str()).collect::<HashSet<_>>(), scenarios);
        assert!(incoming.iter().all(|edge| edge.source_handle.as_deref() == Some("done")));
        assert!(!flow.edges().iter().any(|edge| edge.source_node_id == node.id));
    }
    let mut reachable = HashSet::new();
    let mut queue = VecDeque::from(["start"]);
    while let Some(id) = queue.pop_front() {
        if !reachable.insert(id) {
            continue;
        }
        queue.extend(
            flow.edges()
                .iter()
                .filter(|edge| edge.source_node_id == id)
                .map(|edge| edge.target_node_id.as_str()),
        );
    }
    assert_eq!(
        reachable.len(),
        flow.nodes().len(),
        "imported nodes must be reachable from Start"
    );
}

#[test]
fn quick_local_examples_import_with_their_workloads_and_checks() {
    let examples = [
        (
            "smoke.k6.js",
            include_str!("../../../examples/load-tests/smoke.k6.js"),
            "sharedIterations",
            2,
        ),
        (
            "constant-vus.k6.js",
            include_str!("../../../examples/load-tests/constant-vus.k6.js"),
            "constantVus",
            2,
        ),
        (
            "ramping-vus.k6.js",
            include_str!("../../../examples/load-tests/ramping-vus.k6.js"),
            "rampingVus",
            1,
        ),
        (
            "arrival-rate.k6.js",
            include_str!("../../../examples/load-tests/arrival-rate.k6.js"),
            "constantArrivalRate",
            1,
        ),
        (
            "expected-failure.k6.js",
            include_str!("../../../examples/load-tests/expected-failure.k6.js"),
            "sharedIterations",
            1,
        ),
    ];

    for (name, source, executor, request_count) in examples {
        let analysis = analyze_load_test(name, source, UNIX_EPOCH)
            .unwrap_or_else(|error| panic!("{name} must import successfully: {error}"));
        assert_connected_global_thresholds(&analysis.flow);
        assert!(analysis.required_variables.is_empty(), "{name}");
        assert_eq!(analysis.requests.len(), request_count, "{name}");
        assert!(
            analysis
                .requests
                .iter()
                .all(|request| request.url.starts_with("http://127.0.0.1:8787/")),
            "{name} must target the companion API"
        );
        let configs: Vec<_> = analysis
            .flow
            .nodes()
            .iter()
            .filter_map(|node| match &node.kind {
                FlowNodeKind::Load { node } => Some((
                    node.kind,
                    serde_json::from_str::<serde_json::Value>(&node.config).unwrap(),
                )),
                _ => None,
            })
            .collect();
        let scenarios: Vec<_> = configs
            .iter()
            .filter(|(kind, _)| *kind == LoadNodeKind::Scenario)
            .collect();
        assert_eq!(scenarios.len(), 1, "{name}");
        assert_eq!(scenarios[0].1["executor"], executor, "{name}");
        assert_eq!(
            configs
                .iter()
                .filter(|(kind, _)| *kind == LoadNodeKind::Check)
                .count(),
            request_count,
            "{name} must preserve every response check"
        );
        assert!(
            configs
                .iter()
                .any(|(kind, _)| *kind == LoadNodeKind::Threshold),
            "{name} must preserve thresholds"
        );
    }
}

#[test]
fn substantial_local_example_imports_without_diagnostics_or_missing_variables() {
    let source = include_str!("../../../examples/load-tests/substantial.k6.js");
    let analysis = analyze_load_test("substantial.k6.js", source, UNIX_EPOCH)
        .expect("the runnable example must remain compatible with the importer");
    assert_connected_global_thresholds(&analysis.flow);
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
