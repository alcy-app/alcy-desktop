//! Cópia de segurança dos arquivos principais dos workspaces, feita antes de
//! instalar uma atualização do app (spec 0120). Uma versão nova pode gravar
//! os arquivos num formato que a anterior não lê; com o backup, voltar de
//! versão não perde dados.
//!
//! Cada backup é uma pasta `<data UTC>_<versão atual>-para-<versão nova>`
//! com uma subpasta por workspace e um `backup.json` que diz de onde veio
//! cada uma. Restaurar é copiar os arquivos de volta para o workspace.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use alcy_domain::{ENVIRONMENTS_FILE, VERSIONED_FILES};
use serde::Serialize;

use crate::environment_store::SECRETS_FILE_NAME;
use crate::mock_server_store::MOCK_SERVERS_FILE;
use crate::recent_workspaces_store::RecentWorkspaceEntry;
use crate::storage_error::StorageError;
use crate::tab_session_store::FILE_NAME as TAB_SESSION_FILE;
use crate::workspace_link_store::LINK_FILE_NAME;

/// Quantos backups ficam guardados; os mais antigos são removidos.
pub const KEPT_BACKUPS: usize = 5;

const MANIFEST_FILE: &str = "backup.json";
const PARTIAL_SUFFIX: &str = ".tmp";
const MAX_FOLDER_NAME: usize = 60;

/// Além dos versionados: ambientes, mock servers, vínculo com o repositório
/// e a sessão de abas (que guarda abas ainda não salvas). Histórico e caches
/// ficam de fora: são grandes e não são o trabalho do usuário.
const EXTRA_FILES: [&str; 5] = [
    ENVIRONMENTS_FILE,
    SECRETS_FILE_NAME,
    MOCK_SERVERS_FILE,
    LINK_FILE_NAME,
    TAB_SESSION_FILE,
];

fn backed_up_files() -> impl Iterator<Item = &'static str> {
    VERSIONED_FILES.into_iter().chain(EXTRA_FILES)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceBackup {
    pub dir: PathBuf,
    pub workspaces: usize,
    pub files: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest<'a> {
    created_at: String,
    from_version: &'a str,
    to_version: &'a str,
    workspaces: Vec<BackedUpWorkspace>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackedUpWorkspace {
    folder: String,
    name: String,
    original_path: PathBuf,
    files: Vec<&'static str>,
}

/// Copia os arquivos principais de cada workspace que ainda existe para uma
/// pasta nova em `backups_root` e mantém só os `KEPT_BACKUPS` mais recentes.
/// A pasta só aparece completa: é montada com sufixo `.tmp` e renomeada no
/// fim, e um erro no meio a remove.
pub fn backup_workspaces(
    backups_root: &Path,
    from_version: &str,
    to_version: &str,
    workspaces: &[RecentWorkspaceEntry],
    now: SystemTime,
) -> Result<WorkspaceBackup, StorageError> {
    fs::create_dir_all(backups_root).map_err(write_error(backups_root))?;
    remove_partial_backups(backups_root);

    let (stamp, created_at) = utc_timestamps(now);
    let label = format!(
        "{stamp}_{}-para-{}",
        safe_segment(from_version),
        safe_segment(to_version)
    );
    let final_dir = unused_dir(backups_root, &label);
    let partial_dir = backups_root.join(format!(
        "{}{PARTIAL_SUFFIX}",
        final_dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&label)
    ));

    let result = copy_workspaces(&partial_dir, workspaces).and_then(|backed_up| {
        let files = backed_up.iter().map(|entry| entry.files.len()).sum();
        let count = backed_up.len();
        let manifest = BackupManifest {
            created_at,
            from_version,
            to_version,
            workspaces: backed_up,
        };
        let json = serde_json::to_vec_pretty(&manifest)
            .map_err(|error| StorageError::Write(error.to_string()))?;
        let manifest_path = partial_dir.join(MANIFEST_FILE);
        fs::write(&manifest_path, json).map_err(write_error(&manifest_path))?;
        fs::rename(&partial_dir, &final_dir).map_err(write_error(&final_dir))?;
        Ok((count, files))
    });

    match result {
        Ok((workspaces, files)) => {
            // A atualização não deve falhar por não conseguir apagar backups antigos.
            let _ = prune_backups(backups_root, KEPT_BACKUPS);
            Ok(WorkspaceBackup {
                dir: final_dir,
                workspaces,
                files,
            })
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&partial_dir);
            Err(error)
        }
    }
}

fn copy_workspaces(
    target: &Path,
    workspaces: &[RecentWorkspaceEntry],
) -> Result<Vec<BackedUpWorkspace>, StorageError> {
    fs::create_dir_all(target).map_err(write_error(target))?;
    let mut backed_up = Vec::new();
    for entry in workspaces {
        if !entry.root_path.is_dir() {
            continue;
        }
        let folder = format!(
            "{:02}-{}",
            backed_up.len() + 1,
            safe_folder_name(&entry.name)
        );
        let folder_path = target.join(&folder);
        let mut files = Vec::new();
        for name in backed_up_files() {
            let source = entry.root_path.join(name);
            if !source.is_file() {
                continue;
            }
            if files.is_empty() {
                fs::create_dir_all(&folder_path).map_err(write_error(&folder_path))?;
            }
            let destination = folder_path.join(name);
            fs::copy(&source, &destination)
                .map_err(|error| StorageError::Write(format!("{}: {error}", source.display())))?;
            files.push(name);
        }
        if !files.is_empty() {
            backed_up.push(BackedUpWorkspace {
                folder,
                name: entry.name.clone(),
                original_path: entry.root_path.clone(),
                files,
            });
        }
    }
    Ok(backed_up)
}

/// Remove os backups mais antigos além de `keep`. Só pastas com
/// `backup.json` contam: nada mais em `backups_root` é apagado.
fn prune_backups(backups_root: &Path, keep: usize) -> Result<(), StorageError> {
    let mut backups: Vec<PathBuf> = fs::read_dir(backups_root)
        .map_err(|error| StorageError::Read(error.to_string()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir() && path.join(MANIFEST_FILE).is_file())
        .collect();
    // Os nomes começam pela data, então a ordem alfabética é a cronológica.
    backups.sort();
    let excess = backups.len().saturating_sub(keep);
    for old in &backups[..excess] {
        fs::remove_dir_all(old).map_err(write_error(old))?;
    }
    Ok(())
}

/// Restos de um backup interrompido (queda de energia, app encerrado).
fn remove_partial_backups(backups_root: &Path) {
    let Ok(entries) = fs::read_dir(backups_root) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let partial = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(PARTIAL_SUFFIX));
        if partial && path.is_dir() {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

fn unused_dir(root: &Path, label: &str) -> PathBuf {
    let mut candidate = root.join(label);
    let mut suffix = 2;
    while candidate.exists() {
        candidate = root.join(format!("{label}-{suffix}"));
        suffix += 1;
    }
    candidate
}

fn write_error(path: &Path) -> impl Fn(std::io::Error) -> StorageError + '_ {
    move |error| StorageError::Write(format!("{}: {error}", path.display()))
}

/// A versão nova vem do manifesto do servidor: só caracteres seguros entram
/// no nome da pasta.
fn safe_segment(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+') {
                c
            } else {
                '_'
            }
        })
        .take(32)
        .collect();
    let cleaned = cleaned.trim_matches('.');
    if cleaned.is_empty() {
        "desconhecida".to_string()
    } else {
        cleaned.to_string()
    }
}

/// Nome do workspace como pasta, válido no Windows e no Linux.
fn safe_folder_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .take(MAX_FOLDER_NAME)
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.');
    if cleaned.is_empty() {
        "workspace".to_string()
    } else {
        cleaned.to_string()
    }
}

/// (`2026-10-06_14-30-05`, `2026-10-06T14:30:05Z`), em UTC.
fn utc_timestamps(now: SystemTime) -> (String, String) {
    let seconds = now
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let (days, rest) = (seconds / 86_400, seconds % 86_400);
    let (year, month, day) = civil_from_days(days as i64);
    let (hour, minute, second) = (rest / 3_600, rest % 3_600 / 60, rest % 60);
    (
        format!("{year:04}-{month:02}-{day:02}_{hour:02}-{minute:02}-{second:02}"),
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z"),
    )
}

/// Dias desde 1970-01-01 para (ano, mês, dia), pelo calendário gregoriano
/// (algoritmo `civil_from_days` de Howard Hinnant).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("alcy-workspace-backup-test-{nanos}-{count}"))
    }

    fn at(seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(seconds)
    }

    fn workspace(root: &Path, name: &str, files: &[(&str, &str)]) -> RecentWorkspaceEntry {
        let path = root.join("workspaces").join(name);
        fs::create_dir_all(&path).unwrap();
        for (file, content) in files {
            fs::write(path.join(file), content).unwrap();
        }
        RecentWorkspaceEntry {
            root_path: path,
            name: name.to_string(),
        }
    }

    #[test]
    fn copies_the_main_files_and_records_where_they_came_from() {
        let root = temp_root();
        let first = workspace(
            &root,
            "API",
            &[
                ("alcy-collections.json", "coleções"),
                ("alcy-environments.json", "ambientes"),
                ("alcy-tab-session.json", "abas"),
                ("alcy-history.json", "histórico grande"),
            ],
        );
        let missing = RecentWorkspaceEntry {
            root_path: root.join("apagado"),
            name: "Apagado".into(),
        };
        let backups = root.join("backups");

        let backup = backup_workspaces(
            &backups,
            "0.6.0",
            "0.7.0",
            &[first, missing],
            at(1_791_297_005),
        )
        .unwrap();

        assert_eq!(
            backup.dir,
            backups.join("2026-10-06_14-30-05_0.6.0-para-0.7.0")
        );
        assert_eq!((backup.workspaces, backup.files), (1, 3));
        let copied = backup.dir.join("01-API");
        assert_eq!(
            fs::read_to_string(copied.join("alcy-collections.json")).unwrap(),
            "coleções"
        );
        assert!(copied.join("alcy-tab-session.json").is_file());
        assert!(!copied.join("alcy-history.json").exists());

        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(backup.dir.join(MANIFEST_FILE)).unwrap()).unwrap();
        assert_eq!(manifest["createdAt"], "2026-10-06T14:30:05Z");
        assert_eq!(manifest["toVersion"], "0.7.0");
        assert_eq!(manifest["workspaces"][0]["folder"], "01-API");
        assert_eq!(manifest["workspaces"].as_array().unwrap().len(), 1);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn workspaces_with_the_same_name_get_separate_folders() {
        let root = temp_root();
        let first = workspace(&root, "a/API", &[("alcy-flows.json", "1")]);
        let second = RecentWorkspaceEntry {
            name: "API".into(),
            ..workspace(&root, "b/API", &[("alcy-flows.json", "2")])
        };
        let first = RecentWorkspaceEntry {
            name: "API".into(),
            ..first
        };

        let backup =
            backup_workspaces(&root.join("backups"), "1", "2", &[first, second], at(0)).unwrap();

        assert_eq!(
            fs::read_to_string(backup.dir.join("01-API/alcy-flows.json")).unwrap(),
            "1"
        );
        assert_eq!(
            fs::read_to_string(backup.dir.join("02-API/alcy-flows.json")).unwrap(),
            "2"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn keeps_only_the_most_recent_backups_and_never_touches_other_folders() {
        let root = temp_root();
        let entry = workspace(&root, "API", &[("alcy-collections.json", "[]")]);
        let backups = root.join("backups");
        fs::create_dir_all(backups.join("minhas-coisas")).unwrap();
        fs::create_dir_all(backups.join("2020-01-01_00-00-00_x-para-y.tmp")).unwrap();

        for day in 0..(KEPT_BACKUPS as u64 + 2) {
            backup_workspaces(
                &backups,
                "1",
                "2",
                std::slice::from_ref(&entry),
                at(day * 86_400),
            )
            .unwrap();
        }

        let mut names: Vec<String> = fs::read_dir(&backups)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names.len(), KEPT_BACKUPS + 1);
        assert_eq!(names[0], "1970-01-03_00-00-00_1-para-2");
        assert!(names.contains(&"minhas-coisas".to_string()));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn two_backups_in_the_same_second_do_not_collide() {
        let root = temp_root();
        let entry = workspace(&root, "API", &[("alcy-collections.json", "[]")]);
        let backups = root.join("backups");

        let first =
            backup_workspaces(&backups, "1", "2", std::slice::from_ref(&entry), at(0)).unwrap();
        let second =
            backup_workspaces(&backups, "1", "2", std::slice::from_ref(&entry), at(0)).unwrap();

        assert_ne!(first.dir, second.dir);
        assert!(second.dir.ends_with("1970-01-01_00-00-00_1-para-2-2"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn names_from_outside_cannot_escape_the_backup_folder() {
        assert_eq!(safe_segment("../../etc"), "_.._etc");
        assert_eq!(safe_segment("0.7.0-beta.1"), "0.7.0-beta.1");
        assert_eq!(safe_segment(""), "desconhecida");
        assert_eq!(safe_folder_name("API: <prod>/v2"), "API_ _prod__v2");
        assert_eq!(safe_folder_name(" .. "), "workspace");
    }

    #[test]
    fn converts_days_to_the_gregorian_calendar() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
        assert_eq!(utc_timestamps(at(1_709_251_199)).1, "2024-02-29T23:59:59Z");
    }
}
