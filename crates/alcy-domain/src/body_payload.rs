use std::path::Path;

/// Que tipo de corpo REST uma requisição carrega — paralelo ao seletor
/// "None / Form-data / x-www-form-urlencoded / Raw / Binary" da UI.
///
/// `None`/`Raw` usam o texto de `RequestDocument::body`. `UrlEncoded`,
/// `FormData` e `Binary` carregam os dados estruturados e o executor REST
/// monta o corpo a partir deles (codificação, multipart ou bytes de um
/// arquivo) — assim a interpolação de `{{var}}` acontece campo a campo,
/// antes de qualquer codificação.
///
/// Fica em `Request`, não em `RequestDocument`: é um conceito específico de
/// REST (GraphQL não tem tipo de corpo), então não pertence ao núcleo
/// genérico — mesmo raciocínio de `variables`, ignorado pelo executor REST.
/// `Request::new` inicia em `Raw` (JSON) para preservar o comportamento de
/// toda requisição já existente antes deste campo existir.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BodyPayload {
    None,
    Raw { language: RawBodyLanguage },
    UrlEncoded(Vec<UrlEncodedField>),
    FormData(Vec<FormDataField>),
    Binary { file_path: String },
}

/// Sublinguagem de um corpo "raw" — só afeta realce de sintaxe no editor e o
/// `Content-Type` sincronizado automaticamente; nunca interpretada pela
/// execução.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RawBodyLanguage {
    Text,
    JavaScript,
    #[default]
    Json,
    Html,
    Xml,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlEncodedField {
    pub name: String,
    pub value: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormDataField {
    pub name: String,
    pub enabled: bool,
    pub value: FormDataFieldValue,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FormDataFieldValue {
    Text(String),
    File { file_path: String },
}

impl BodyPayload {
    /// Resolve caminhos de arquivo relativos contra a raiz do workspace.
    /// Arquivos dentro do workspace são salvos com caminho relativo (portável
    /// entre máquinas e sistemas, e sem expor a estrutura de pastas local
    /// numa coleção versionada); caminhos absolutos ficam como estão.
    pub fn with_files_resolved_against(&self, root: &Path) -> BodyPayload {
        let resolve = |file_path: &str| resolve_file_path(root, file_path);
        match self {
            Self::FormData(fields) => Self::FormData(
                fields
                    .iter()
                    .map(|field| FormDataField {
                        value: match &field.value {
                            FormDataFieldValue::File { file_path } => FormDataFieldValue::File {
                                file_path: resolve(file_path),
                            },
                            text => text.clone(),
                        },
                        ..field.clone()
                    })
                    .collect(),
            ),
            Self::Binary { file_path } => Self::Binary {
                file_path: resolve(file_path),
            },
            other => other.clone(),
        }
    }
}

/// Caminho absoluto de um arquivo de corpo: relativo → junto à raiz do
/// workspace; absoluto ou vazio → inalterado. Separadores `/` funcionam
/// também no Windows.
pub fn resolve_file_path(root: &Path, file_path: &str) -> String {
    let path = Path::new(file_path);
    if file_path.is_empty() || path.is_absolute() {
        return file_path.to_string();
    }
    root.join(path).to_string_lossy().into_owned()
}

impl Default for BodyPayload {
    fn default() -> Self {
        Self::Raw {
            language: RawBodyLanguage::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_file_paths_against_the_workspace_root() {
        let root = std::env::temp_dir().join("workspace");
        let payload = BodyPayload::FormData(vec![
            FormDataField {
                name: "file".to_string(),
                enabled: true,
                value: FormDataFieldValue::File {
                    file_path: "files/photo.png".to_string(),
                },
            },
            FormDataField {
                name: "title".to_string(),
                enabled: true,
                value: FormDataFieldValue::Text("files/not-a-path".to_string()),
            },
        ]);

        let resolved = payload.with_files_resolved_against(&root);

        let BodyPayload::FormData(fields) = resolved else {
            panic!("esperava form-data");
        };
        assert_eq!(
            fields[0].value,
            FormDataFieldValue::File {
                file_path: root.join("files/photo.png").to_string_lossy().into_owned()
            }
        );
        assert_eq!(
            fields[1].value,
            FormDataFieldValue::Text("files/not-a-path".to_string())
        );
    }

    #[test]
    fn keeps_absolute_and_empty_paths_as_they_are() {
        let root = std::env::temp_dir().join("workspace");
        let absolute = std::env::temp_dir()
            .join("elsewhere.bin")
            .to_string_lossy()
            .into_owned();

        assert_eq!(resolve_file_path(&root, &absolute), absolute);
        assert_eq!(resolve_file_path(&root, ""), "");
    }
}
