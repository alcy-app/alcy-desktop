//! Downloads real packages from esm.sh and runs them in the script sandbox.
//! Ignored by default (network); run with `cargo test -p alcy-script-packages -- --ignored`.

use std::sync::Arc;

use alcy_script_packages::{PackageCache, esm_sh_client, fetch_from_esm_sh, resolve_packages};
use alcy_scripting::{
    ScriptInput, ScriptIteration, ScriptPhase, ScriptRequest, npm_requests, run_script,
};

#[tokio::test]
#[ignore = "network: downloads from esm.sh"]
async fn runs_real_esm_sh_packages() {
    let source = r#"
        var dayjs = require('npm:dayjs@1.11.13');
        var uuid = require('npm:uuid@11.0.3');
        al.console.log(dayjs('2024-01-02').add(1, 'day').format('YYYY-MM-DD'));
        al.console.log(uuid.validate(uuid.v4()));
    "#;
    let dir = std::env::temp_dir().join(format!("alcy-esm-sh-{}", std::process::id()));
    let client = esm_sh_client().unwrap();
    let packages = resolve_packages(&npm_requests(source), &PackageCache::new(&dir), |path| {
        let client = client.clone();
        async move { fetch_from_esm_sh(&client, &path).await }
    })
    .await
    .unwrap();
    let input = ScriptInput {
        request: ScriptRequest {
            url: "https://example.com".to_string(),
            method: "get".to_string(),
            body: String::new(),
            headers: Vec::new(),
        },
        response: None,
        environment: Vec::new(),
        collection: None,
        folder: None,
        local: Vec::new(),
        runtime: Vec::new(),
        iteration: ScriptIteration::default(),
        packages: Arc::new(packages),
    };
    let output = run_script(ScriptPhase::PreRequest, source, &input)
        .unwrap_or_else(|error| panic!("{}", error.message));
    assert_eq!(output.logs, vec!["2024-01-03", "true"]);
    let _ = std::fs::remove_dir_all(dir);
}
