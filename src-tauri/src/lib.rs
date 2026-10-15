mod commands;
mod logging;
mod mock_runtime;
mod window_state;

use alcy_gitlab::GitlabClient;
use alcy_graphql::ReqwestGraphqlExecutor;
use alcy_platform::KeyringCredentialStore;
use alcy_rest::ReqwestRestExecutor;
use alcy_storage::{
    ApiDocsStore, CustomCaCertificateStore, GeneralSettingsStore, GitlabAccountsStore,
    LocalSecrets, ProxySettingsStore, RecentWorkspacesStore, SchemaStore, SecuritySettingsStore,
    TlsSettingsStore, UpdateSettingsStore,
};
use commands::api_docs::get_request_docs;
use commands::app_logs::{AppLogLocation, write_frontend_logs};
use commands::body_files::check_body_files;
use commands::cancel_flow::cancel_flow;
use commands::cancel_graphql_request::cancel_graphql_request;
use commands::cancel_load_flow::cancel_load_flow;
use commands::collections::{
    PreparedImports, commit_prepared_import, discard_prepared_import, expand_import_paths,
    export_collections, import_collections, import_collections_from_text,
    import_collections_from_url, list_collections, prepare_import_from_path,
    prepare_import_from_text, prepare_import_from_url, save_collections, serialize_collections,
};
use commands::custom_ca_certificates::{
    add_custom_ca_certificate, apply_saved_custom_ca_certificates, list_custom_ca_certificates,
    remove_custom_ca_certificate,
};
use commands::environments::{list_environments, save_environments};
use commands::execute_collection_run::{
    CollectionRunOutputs, cancel_collection_run, execute_collection_run, get_collection_run_output,
    preview_iteration_data,
};
use commands::execute_flow::execute_flow;
use commands::execute_graphql_request::execute_graphql_request;
use commands::execute_load_flow::execute_load_flow;
use commands::execute_rest_request::execute_rest_request;
use commands::execution_registry::ExecutionRegistry;
use commands::export_collection_run_report::export_collection_run_report;
use commands::export_har::export_har;
use commands::export_png::export_png;
use commands::export_webclient::{export_webclient, preview_webclient_export};
use commands::flow_execution_registry::FlowExecutionRegistry;
use commands::flow_run_outputs::{FlowRunOutputs, get_flow_node_output};
use commands::flows::{list_flows, save_flows};
use commands::general_settings::{
    HistoryPreferencesState, apply_saved_general_settings, get_general_settings,
    is_previous_install, save_general_settings,
};
use commands::get_load_run_history::{get_load_run_history, get_load_run_samples};
use commands::gitlab::{
    begin_gitlab_login, cancel_gitlab_operation, list_gitlab_accounts, list_gitlab_branches,
    list_gitlab_projects, logout_gitlab, test_gitlab_connection,
};
use commands::grpc::{
    GrpcCalls, GrpcSchemaCache, close_grpc_send, execute_grpc_request, load_grpc_schema,
    send_grpc_message,
};
use commands::history::{
    get_collection_run_history, get_flow_run_history, get_history_entry, list_history,
};
use commands::import_fetcher::ImportFetcher;
use commands::load_dataset_assets::copy_load_dataset_asset;
use commands::load_schema::load_schema;
use commands::load_test_import::{analyze_load_test_import, commit_load_test_import};
use commands::mock_servers::{
    MockServerRuntime, clear_mock_calls, delete_mock_server, get_mock_server, list_mock_calls,
    list_mock_servers, save_mock_server, start_mock_server, stop_mock_server,
};
use commands::open_external_url::open_external_url;
use commands::preview_load_flow::preview_load_flow;
use commands::proxy_settings::{
    ProxyApplyState, apply_saved_settings, get_proxy_settings, save_proxy_settings,
    test_proxy_settings,
};
use commands::read_response_body_chunk::read_response_body_chunk;
use commands::release_response_body::release_response_body;
use commands::remote_content_cache::VersionControlCaches;
use commands::response_body_cache::ResponseBodyCache;
use commands::save_response_body::save_response_body;
use commands::security_settings::{get_security_settings, save_security_settings};
use commands::send_history::{compare_request_sends, list_request_sends, set_send_baseline};
use commands::session_cookies::{
    SessionCookies, clear_session_cookies, delete_session_cookie, list_session_cookies,
};
use commands::tab_session::{load_tab_session, save_tab_session};
use commands::tls_settings::{apply_saved_tls_settings, get_tls_settings, save_tls_settings};
use commands::updates::{
    PendingUpdate, cancel_update_operation, check_for_update, download_update, get_update_settings,
    install_update_and_restart, set_update_check_on_startup,
};
use commands::value_monitors::{evaluate_value_monitors, list_value_monitors, save_value_monitors};
use commands::version_control::{
    VersionControlFiles, commit_and_push, get_file_diff, get_local_version_status,
    get_structured_file_changes, get_version_status, get_workspace_link, link_workspace,
    preview_conflict_resolution, preview_pull_changes, pull_changes, resolve_conflict,
    unlink_workspace,
};
use commands::workspace_operation_coordinator::WorkspaceOperationCoordinator;
use commands::workspaces::{
    create_workspace, list_recent_workspaces, open_workspace, remove_workspace, rename_workspace,
};
use tauri::Manager;

/// WebKitGTK has no native undo/redo key bindings in text fields, unlike
/// WebView2, which handles Ctrl+Z/Ctrl+Y in focused inputs and textareas.
/// Tauri Undo/Redo menu items do not help: the GTK backend of muda only
/// implements Copy/Cut/Paste/Select All. Intercept the keys on the webview
/// widget and forward them to the WebKit editing command, which targets
/// the focused text field on the page.
#[cfg(target_os = "linux")]
fn enable_linux_text_undo_redo(app: &tauri::App) -> tauri::Result<()> {
    use gtk::gdk::ModifierType;
    use gtk::glib::Propagation;
    use gtk::prelude::WidgetExt;
    use webkit2gtk::WebViewExt;

    let Some(main_webview) = app.get_webview_window("main") else {
        return Ok(());
    };

    main_webview.with_webview(|webview| {
        let webview = webview.inner();
        webview.connect_key_press_event(|webview, event| {
            let modifiers = event.state();
            let ctrl_only = modifiers.contains(ModifierType::CONTROL_MASK)
                && !modifiers.contains(ModifierType::SHIFT_MASK);
            if ctrl_only {
                match event.keyval().to_unicode().map(|c| c.to_ascii_lowercase()) {
                    Some('z') => {
                        webview.execute_editing_command("Undo");
                        return Propagation::Stop;
                    }
                    Some('y') => {
                        webview.execute_editing_command("Redo");
                        return Propagation::Stop;
                    }
                    _ => {}
                }
            }
            Propagation::Proceed
        });
    })
}

/// Wrap the generated handler to log each invoked command name
/// through logging::log_invoke.
fn log_invocations<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        logging::log_invoke(invoke.message.command());
        handler(invoke)
    }
}

type ExtensionInvoke = Box<dyn Fn(tauri::ipc::Invoke) -> bool + Send + Sync>;
type ExtensionSetup =
    Box<dyn FnOnce(&mut tauri::App) -> Result<(), Box<dyn std::error::Error>> + Send>;

/// Additions a downstream build plugs into the app (see `run_with`): commands
/// of its own, invoked like the app's, and setup that runs after the app's.
pub struct Extension {
    /// Commands handled by `invoke`; they take precedence over the app's.
    /// They stay out of the app's IPC log: `invoke` logs what it needs.
    pub commands: &'static [&'static str],
    pub invoke: ExtensionInvoke,
    pub setup: ExtensionSetup,
}

/// Index of the extension that handles `command`, if any.
fn extension_for(extension_commands: &[&[&str]], command: &str) -> Option<usize> {
    extension_commands
        .iter()
        .position(|commands| commands.contains(&command))
}

/// Sends the extensions' commands to them and everything else to the app.
fn with_extension_commands(
    extension_commands: Vec<&'static [&'static str]>,
    extension_invokes: Vec<ExtensionInvoke>,
    app_commands: impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    move |invoke| {
        let command = invoke.message.command();
        match extension_for(&extension_commands, command) {
            Some(index) => extension_invokes[index](invoke),
            None => app_commands(invoke),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    run_with(Vec::new());
}

/// Runs the app with the given extensions.
pub fn run_with(extensions: Vec<Extension>) {
    let mut extension_commands = Vec::new();
    let mut extension_invokes = Vec::new();
    let mut extension_setups = Vec::new();
    for extension in extensions {
        extension_commands.push(extension.commands);
        extension_invokes.push(extension.invoke);
        extension_setups.push(extension.setup);
    }

    tauri::Builder::default()
        .manage(ExecutionRegistry::default())
        .manage(GrpcSchemaCache::default())
        .manage(GrpcCalls::default())
        .manage(WorkspaceOperationCoordinator::default())
        .manage(FlowExecutionRegistry::default())
        .manage(FlowRunOutputs::default())
        .manage(CollectionRunOutputs::default())
        .manage(ReqwestGraphqlExecutor::new())
        .manage(ReqwestRestExecutor::new())
        .manage(HistoryPreferencesState::default())
        .manage(ResponseBodyCache::default())
        .manage(MockServerRuntime::default())
        .manage(SessionCookies::default())
        .manage(ImportFetcher::new())
        .manage(PreparedImports::default())
        .manage(ApiDocsStore::new())
        .manage(GitlabClient::new())
        .manage(KeyringCredentialStore::new("alcy"))
        .manage(PendingUpdate::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(window_state::plugin())
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                window_state::show_main_window(webview.app_handle());
            }
        })
        .setup(move |app| {
            // Decide initial preferences for upgrading users before writing
            // anything into the application data directory.
            let previous_install = app
                .path()
                .app_data_dir()
                .is_ok_and(|dir| is_previous_install(&dir));
            // Enable local rotating file logs in every build under
            // the user Documents/Alcy/logs directory.
            let alcy_dirs = logging::alcy_dirs(app)?;
            app.handle().plugin(logging::plugin(&alcy_dirs.logs))?;
            logging::spawn_expired_logs_cleanup(alcy_dirs.logs.clone());
            log::info!(
                target: "alcy::app",
                "Alcy {} iniciado ({}/{}, build {})",
                app.package_info().version,
                std::env::consts::OS,
                std::env::consts::ARCH,
                if cfg!(debug_assertions) { "debug" } else { "release" }
            );
            app.manage(AppLogLocation {
                backups: alcy_dirs.backups,
            });

            let app_data_dir = app.path().app_data_dir()?;
            commands::scripting::init_script_packages(app_data_dir.join("script-packages"));
            app.manage(SchemaStore::new(app_data_dir.join("schema-cache")));
            app.manage(VersionControlCaches::new(
                app_data_dir.join("gitlab-content-cache"),
            ));
            app.manage(RecentWorkspacesStore::new(
                app_data_dir.join("recent-workspaces.json"),
            ));
            app.manage(ProxySettingsStore::new(
                app_data_dir.join("proxy-settings.json"),
            ));
            app.manage(GitlabAccountsStore::new(
                app_data_dir.join("gitlab-accounts.json"),
            ));
            app.manage(UpdateSettingsStore::new(
                app_data_dir.join("update-settings.json"),
            ));
            app.manage(SecuritySettingsStore::new(
                app_data_dir.join("security-settings.json"),
            ));
            let custom_ca_store =
                CustomCaCertificateStore::new(app_data_dir.join("custom-ca-certificates.json"));
            apply_saved_custom_ca_certificates(
                &custom_ca_store,
                &app.state::<ReqwestGraphqlExecutor>(),
                &app.state::<ReqwestRestExecutor>(),
                &app.state::<ImportFetcher>(),
                &app.state::<GitlabClient>(),
            );
            app.manage(custom_ca_store);
            let tls_settings = TlsSettingsStore::new(app_data_dir.join("tls-settings.json"));
            apply_saved_tls_settings(
                &tls_settings,
                &app.state::<ReqwestGraphqlExecutor>(),
                &app.state::<ReqwestRestExecutor>(),
            );
            app.manage(tls_settings);
            // Encrypt sensitive values using the system keyring, with a fallback
            // file outside workspaces.
            let local_secrets = LocalSecrets::new(
                Box::new(KeyringCredentialStore::new("alcy")),
                app_data_dir.join("local-secret.key"),
            );
            app.manage(VersionControlFiles::new(
                local_secrets.clone(),
                SecuritySettingsStore::new(app_data_dir.join("security-settings.json")),
            ));
            app.manage(local_secrets);
            app.manage(ProxyApplyState::default());

            window_state::restore_main_window(app);

            let general_settings =
                GeneralSettingsStore::new(app_data_dir.join("general-settings.json"));
            apply_saved_general_settings(
                &general_settings,
                previous_install,
                &app.state::<ReqwestGraphqlExecutor>(),
                &app.state::<ReqwestRestExecutor>(),
                &app.state::<HistoryPreferencesState>(),
            );
            app.manage(general_settings);

            // Apply the saved proxy without delaying the window (PAC downloads
            // its script). Requests use a direct connection until it finishes.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                apply_saved_settings(
                    &handle.state::<ProxySettingsStore>(),
                    &handle.state::<ProxyApplyState>(),
                    &handle.state::<ReqwestGraphqlExecutor>(),
                    &handle.state::<ReqwestRestExecutor>(),
                    &handle.state::<ImportFetcher>(),
                    &handle.state::<GitlabClient>(),
                )
                .await;
            });

            #[cfg(target_os = "linux")]
            enable_linux_text_undo_redo(app)?;

            for setup in extension_setups {
                setup(app)?;
            }

            Ok(())
        })
        .invoke_handler(with_extension_commands(
            extension_commands,
            extension_invokes,
            log_invocations(tauri::generate_handler![
                execute_graphql_request,
                execute_rest_request,
                execute_grpc_request,
                load_grpc_schema,
                send_grpc_message,
                close_grpc_send,
                check_body_files,
                cancel_graphql_request,
                list_environments,
                save_environments,
                list_flows,
                save_flows,
                list_mock_servers,
                get_mock_server,
                save_mock_server,
                delete_mock_server,
                start_mock_server,
                stop_mock_server,
                list_mock_calls,
                clear_mock_calls,
                analyze_load_test_import,
                commit_load_test_import,
                preview_load_flow,
                execute_load_flow,
                copy_load_dataset_asset,
                get_load_run_history,
                get_load_run_samples,
                list_value_monitors,
                save_value_monitors,
                load_tab_session,
                save_tab_session,
                evaluate_value_monitors,
                execute_flow,
                get_flow_node_output,
                cancel_flow,
                cancel_load_flow,
                execute_collection_run,
                cancel_collection_run,
                get_collection_run_output,
                preview_iteration_data,
                export_collection_run_report,
                load_schema,
                get_request_docs,
                create_workspace,
                open_workspace,
                remove_workspace,
                rename_workspace,
                list_recent_workspaces,
                get_proxy_settings,
                save_proxy_settings,
                test_proxy_settings,
                list_custom_ca_certificates,
                add_custom_ca_certificate,
                remove_custom_ca_certificate,
                get_tls_settings,
                save_tls_settings,
                get_general_settings,
                save_general_settings,
                get_security_settings,
                save_security_settings,
                list_gitlab_accounts,
                begin_gitlab_login,
                cancel_gitlab_operation,
                logout_gitlab,
                test_gitlab_connection,
                list_gitlab_projects,
                list_gitlab_branches,
                get_workspace_link,
                link_workspace,
                unlink_workspace,
                get_version_status,
                get_local_version_status,
                get_file_diff,
                get_structured_file_changes,
                commit_and_push,
                preview_conflict_resolution,
                preview_pull_changes,
                pull_changes,
                resolve_conflict,
                list_collections,
                save_collections,
                export_collections,
                export_har,
                export_png,
                preview_webclient_export,
                export_webclient,
                import_collections,
                prepare_import_from_path,
                prepare_import_from_text,
                prepare_import_from_url,
                commit_prepared_import,
                discard_prepared_import,
                expand_import_paths,
                import_collections_from_text,
                serialize_collections,
                import_collections_from_url,
                list_history,
                open_external_url,
                get_history_entry,
                list_request_sends,
                compare_request_sends,
                set_send_baseline,
                get_flow_run_history,
                get_collection_run_history,
                read_response_body_chunk,
                release_response_body,
                save_response_body,
                get_update_settings,
                set_update_check_on_startup,
                check_for_update,
                download_update,
                cancel_update_operation,
                install_update_and_restart,
                write_frontend_logs,
                list_session_cookies,
                delete_session_cookie,
                clear_session_cookies
            ]),
        ))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::extension_for;

    #[test]
    fn an_extension_command_goes_to_the_extension_that_declares_it() {
        let commands: Vec<&[&str]> = vec![&["get_status"], &["save_note", "list_notes"]];

        assert_eq!(extension_for(&commands, "get_status"), Some(0));
        assert_eq!(extension_for(&commands, "list_notes"), Some(1));
        assert_eq!(extension_for(&commands, "execute_rest_request"), None);
        assert_eq!(extension_for(&[], "get_status"), None);
    }
}
