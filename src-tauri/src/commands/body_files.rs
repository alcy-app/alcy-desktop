use std::path::Path;

use alcy_domain::resolve_file_path;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckBodyFilesInput {
    pub root_path: String,
    pub paths: Vec<String>,
}

/// Diz, para cada caminho de arquivo de corpo (relativo ao workspace ou
/// absoluto), se ele existe — usado pela aba Body para avisar antes do envio
/// que um arquivo salvo não está nesta máquina (ex.: coleção vinda do Git).
#[tauri::command]
pub async fn check_body_files(input: CheckBodyFilesInput) -> Vec<bool> {
    check_body_files_inner(&input).await
}

async fn check_body_files_inner(input: &CheckBodyFilesInput) -> Vec<bool> {
    let root = Path::new(&input.root_path);
    let mut exists = Vec::with_capacity(input.paths.len());
    for path in &input.paths {
        let resolved = resolve_file_path(root, path);
        let is_file = !resolved.is_empty()
            && tokio::fs::metadata(&resolved)
                .await
                .map(|metadata| metadata.is_file())
                .unwrap_or(false);
        exists.push(is_file);
    }
    exists
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reports_which_files_exist_resolving_relative_paths_against_the_root() {
        let root =
            std::env::temp_dir().join(format!("alcy-body-files-test-{}", std::process::id()));
        std::fs::create_dir_all(root.join("files")).unwrap();
        std::fs::write(root.join("files/photo.png"), b"x").unwrap();
        let absolute = root.join("files/photo.png").to_string_lossy().into_owned();

        let exists = check_body_files_inner(&CheckBodyFilesInput {
            root_path: root.to_string_lossy().into_owned(),
            paths: vec![
                "files/photo.png".to_string(),
                absolute,
                "files/missing.png".to_string(),
                "files".to_string(),
                String::new(),
            ],
        })
        .await;

        assert_eq!(exists, vec![true, true, false, false, false]);
        std::fs::remove_dir_all(&root).ok();
    }
}
