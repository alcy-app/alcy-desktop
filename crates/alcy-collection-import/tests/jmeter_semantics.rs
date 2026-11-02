use std::time::UNIX_EPOCH;

use alcy_collection_import::{LoadTestImportError, analyze_load_test};
use alcy_domain::{FlowNodeKind, LoadNodeKind};

fn source(group: &str, sampler: &str) -> String {
    format!(
        r#"<jmeterTestPlan><hashTree><TestPlan/><hashTree>
  <ThreadGroup testname="Users">
    <stringProp name="ThreadGroup.num_threads">2</stringProp>
    {group}
  </ThreadGroup><hashTree>
    <HTTPSamplerProxy testname="Request">
      <boolProp name="HTTPSampler.use_keepalive">true</boolProp>
      <stringProp name="HTTPSampler.domain">example.test</stringProp>
      {sampler}
    </HTTPSamplerProxy><hashTree/>
  </hashTree>
</hashTree></hashTree></jmeterTestPlan>"#
    )
}

fn property(name: &str, value: &str) -> String {
    format!("<stringProp name=\"{name}\">{value}</stringProp>")
}

fn rejected(source: &str, name: &str) {
    let error = analyze_load_test("options.jmx", source, UNIX_EPOCH).unwrap_err();
    let LoadTestImportError::Incompatible { diagnostics } = error else {
        panic!("expected a located incompatibility for {name}");
    };
    assert!(
        diagnostics.iter().any(|diagnostic| {
            diagnostic.message.contains(name) && diagnostic.line > 0 && diagnostic.column > 0
        }),
        "missing located diagnostic for {name}: {diagnostics:?}"
    );
}

#[test]
fn translates_explicit_and_absent_redirect_flags_into_the_native_policy() {
    for (flag, expected) in [
        (None, "manual"),
        (Some("false"), "manual"),
        (Some("true"), "follow"),
        (Some("TRUE"), "follow"),
    ] {
        let option = flag
            .map(|flag| property("HTTPSampler.follow_redirects", flag))
            .unwrap_or_default();
        let analysis =
            analyze_load_test("redirects.jmx", &source("", &option), UNIX_EPOCH).unwrap();
        let request = analysis
            .flow
            .nodes()
            .iter()
            .find_map(|node| match &node.kind {
                FlowNodeKind::Load { node } if node.kind == LoadNodeKind::Request => Some(node),
                _ => None,
            })
            .unwrap();
        let config: serde_json::Value = serde_json::from_str(&request.config).unwrap();
        assert_eq!(config["redirectPolicy"], expected);
    }
}

#[test]
fn accepts_known_neutral_options_and_preserves_the_finite_workload() {
    let group = [
        property("ThreadGroup.same_user_on_next_iteration", "true"),
        property("ThreadGroup.delayedStart", "false"),
        property("ThreadGroup.on_sample_error", "continue"),
        property("TestElement.comments", "${only a comment}"),
    ]
    .join("\n");
    let sampler = [
        property("HTTPSampler.auto_redirects", "false"),
        property("HTTPSampler.image_parser", "false"),
        property("HTTPSampler.concurrentDwn", "false"),
        property("HTTPSampler.concurrentPool", "6"),
        property("HTTPSampler.DO_MULTIPART_POST", "false"),
        property("HTTPSampler.BROWSER_COMPATIBLE_MULTIPART", "false"),
        property("HTTPSampler.md5", "false"),
        property("HTTPSampler.contentEncoding", "UTF-8"),
        property("HTTPSampler.connect_timeout", ""),
        property("HTTPSampler.response_timeout", ""),
    ]
    .join("\n");
    let analysis = analyze_load_test("neutral.jmx", &source(&group, &sampler), UNIX_EPOCH).unwrap();
    assert_eq!(analysis.requests.len(), 1);
    assert_eq!(analysis.requests[0].url, "http://example.test/");
    assert!(
        analysis.requests[0]
            .source_properties
            .iter()
            .any(|(name, value)| name == "HTTPSampler.contentEncoding" && value == "UTF-8")
    );
}

#[test]
fn rejects_effectful_and_unknown_sampler_options_instead_of_saving_only_metadata() {
    for (name, value) in [
        ("HTTPSampler.auto_redirects", "true"),
        ("HTTPSampler.image_parser", "true"),
        ("HTTPSampler.concurrentDwn", "true"),
        ("HTTPSampler.DO_MULTIPART_POST", "true"),
        ("HTTPSampler.BROWSER_COMPATIBLE_MULTIPART", "true"),
        ("HTTPSampler.md5", "true"),
        ("HTTPSampler.contentEncoding", "ISO-8859-1"),
        ("HTTPSampler.connect_timeout", "500"),
        ("HTTPSampler.response_timeout", "500"),
        ("HTTPSampler.response_timeout", "0"),
        ("HTTPSampler.proxyHost", "proxy.example.test"),
        ("HTTPSampler.ipSource", "127.0.0.2"),
        ("HTTPSampler.implementation", "Java"),
        ("HTTPSampler.follow_redirects", "maybe"),
        ("HTTPSampler.postBodyRaw", "1"),
        ("HTTPSampler.future_option", ""),
    ] {
        let input = source("", &property(name, value));
        rejected(&input, name);
        let LoadTestImportError::Incompatible { diagnostics } =
            analyze_load_test("options.jmx", &input, UNIX_EPOCH).unwrap_err()
        else {
            unreachable!()
        };
        assert!(diagnostics.iter().any(|diagnostic| {
            input
                .lines()
                .nth(diagnostic.line - 1)
                .is_some_and(|line| line.contains(name))
        }));
    }
}

#[test]
fn requires_explicit_reusable_connections_and_rejects_unsupported_user_resets() {
    let input = source("", "").replace(
        "<boolProp name=\"HTTPSampler.use_keepalive\">true</boolProp>",
        "",
    );
    rejected(&input, "HTTPSampler.use_keepalive");
    rejected(
        &source("", "").replace("keepalive\">true", "keepalive\">false"),
        "HTTPSampler.use_keepalive",
    );
    for (name, value) in [
        ("ThreadGroup.same_user_on_next_iteration", "false"),
        ("ThreadGroup.same_user_on_next_iteration", "1"),
        ("ThreadGroup.delayedStart", "true"),
        ("ThreadGroup.future_option", ""),
    ] {
        rejected(&source(&property(name, value), ""), name);
    }
}

#[test]
fn preserves_absolute_path_authority_and_unspecified_ports() {
    for (path, port, domain, expected) in [
        ("/items", "0", "example.test", "http://example.test/items"),
        ("items", "-1", "example.test", "http://example.test/items"),
        ("/items", "8787", "127.0.0.1", "http://127.0.0.1:8787/items"),
        ("/items", "", "::1", "http://[::1]/items"),
        (
            "https://destination.test/items?a=1&amp;b=2",
            "invalid-but-ignored",
            "ignored.test",
            "https://destination.test/items?a=1&b=2",
        ),
        (
            "http://destination.test/",
            "",
            "",
            "http://destination.test/",
        ),
    ] {
        let options = format!(
            "{}{}",
            property("HTTPSampler.path", path),
            property("HTTPSampler.port", port)
        );
        let input = source("", &options).replace(
            "<stringProp name=\"HTTPSampler.domain\">example.test</stringProp>",
            &property("HTTPSampler.domain", domain),
        );
        let analysis = analyze_load_test("address.jmx", &input, UNIX_EPOCH).unwrap();
        assert_eq!(analysis.requests[0].url, expected);
    }
    rejected(
        &source("", &property("HTTPSampler.port", "65536")),
        "HTTPSampler.port",
    );
    rejected(
        &source("", "").replace(
            "example.test</stringProp>",
            "https://example.test</stringProp>",
        ),
        "HTTPSampler.domain",
    );
    rejected(
        &source("", "").replace(
            "example.test</stringProp>",
            "example.test:8080</stringProp>",
        ),
        "HTTPSampler.domain",
    );
}

#[test]
fn does_not_echo_unsupported_option_values_in_diagnostics() {
    let input = source(
        "",
        &property("HTTPSampler.proxyPass", "synthetic-private-value"),
    );
    let error = analyze_load_test("private-options.jmx", &input, UNIX_EPOCH).unwrap_err();
    assert!(!error.to_string().contains("synthetic-private-value"));
    rejected(&input, "HTTPSampler.proxyPass");
}

#[test]
fn checks_raw_argument_options_and_preserves_literal_payloads() {
    let arguments = r#"<boolProp name="HTTPSampler.postBodyRaw">true</boolProp>
      <elementProp name="HTTPsampler.Arguments" elementType="Arguments"><collectionProp name="Arguments.arguments">
        <elementProp name="body" elementType="HTTPArgument">
          <stringProp name="Argument.name"></stringProp>
          <stringProp name="Argument.value">{&quot;message&quot;:&quot;café&quot;}</stringProp>
          <boolProp name="HTTPArgument.always_encode">false</boolProp>
        </elementProp>
      </collectionProp></elementProp>"#;
    let input = source("", arguments);
    let analysis = analyze_load_test("body.jmx", &input, UNIX_EPOCH).unwrap();
    assert_eq!(
        analysis.requests[0].body.as_deref(),
        Some("{\"message\":\"café\"}")
    );
    rejected(
        &input.replace("encode\">false", "encode\">true"),
        "HTTPArgument.always_encode",
    );
    rejected(
        &input.replace(
            "Argument.name\"></stringProp>",
            "Argument.name\">field</stringProp>",
        ),
        "Argument.name",
    );
}

#[test]
fn disabled_subtrees_do_not_apply_their_unsupported_options() {
    let disabled = r#"<HTTPSamplerProxy enabled="false"><boolProp name="HTTPSampler.image_parser">true</boolProp></HTTPSamplerProxy><hashTree/>"#;
    let input = source("", "").replace(
        "</HTTPSamplerProxy><hashTree/>",
        &format!("</HTTPSamplerProxy><hashTree/>{disabled}"),
    );
    let analysis = analyze_load_test("disabled.jmx", &input, UNIX_EPOCH).unwrap();
    assert_eq!(analysis.requests.len(), 1);
}

#[test]
fn jmeter_literals_cannot_turn_into_native_runtime_templates() {
    for (name, value) in [
        ("HTTPSampler.path", "/items/{{item}}"),
        ("HTTPSampler.domain", "{{host}}"),
    ] {
        let input = if name == "HTTPSampler.domain" {
            source("", "").replace(
                "example.test</stringProp>",
                &format!("{value}</stringProp>"),
            )
        } else {
            source("", &property(name, value))
        };
        rejected(&input, name);
    }
    let input = source("", &property("TestElement.comments", "{{only a comment}}"));
    assert!(analyze_load_test("comments.jmx", &input, UNIX_EPOCH).is_ok());
}
