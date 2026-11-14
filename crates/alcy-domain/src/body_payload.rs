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
    /// Paths of the files a send reads: binary, and enabled form-data file
    /// fields. Empty paths are left out.
    pub fn sent_file_paths(&self) -> Vec<&str> {
        match self {
            Self::FormData(fields) => fields
                .iter()
                .filter(|field| field.enabled)
                .filter_map(|field| match &field.value {
                    FormDataFieldValue::File { file_path } if !file_path.is_empty() => {
                        Some(file_path.as_str())
                    }
                    _ => None,
                })
                .collect(),
            Self::Binary { file_path } if !file_path.is_empty() => vec![file_path.as_str()],
            _ => Vec::new(),
        }
    }

    /// The same body with every file path replaced by `map(path)`.
    pub fn map_file_paths(&self, mut map: impl FnMut(&str) -> String) -> BodyPayload {
        match self {
            Self::FormData(fields) => Self::FormData(
                fields
                    .iter()
                    .map(|field| FormDataField {
                        value: match &field.value {
                            FormDataFieldValue::File { file_path } => FormDataFieldValue::File {
                                file_path: map(file_path),
                            },
                            text => text.clone(),
                        },
                        ..field.clone()
                    })
                    .collect(),
            ),
            Self::Binary { file_path } => Self::Binary {
                file_path: map(file_path),
            },
            other => other.clone(),
        }
    }
}

/// Absolute path of a body file: a relative one is joined to the workspace
/// root, an absolute or empty one is kept. `/` separators also work on
/// Windows. This does not decide whether the file may be read: sends go
/// through the body file authorization (spec 0163).
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

    fn file_field(path: &str, enabled: bool) -> FormDataField {
        FormDataField {
            name: "file".to_string(),
            enabled,
            value: FormDataFieldValue::File {
                file_path: path.to_string(),
            },
        }
    }

    #[test]
    fn lists_only_the_files_a_send_reads() {
        let payload = BodyPayload::FormData(vec![
            file_field("files/photo.png", true),
            file_field("/elsewhere/disabled.bin", false),
            file_field("", true),
            FormDataField {
                name: "title".to_string(),
                enabled: true,
                value: FormDataFieldValue::Text("files/not-a-path".to_string()),
            },
        ]);
        assert_eq!(payload.sent_file_paths(), vec!["files/photo.png"]);
        assert_eq!(
            BodyPayload::Binary {
                file_path: "a.bin".to_string()
            }
            .sent_file_paths(),
            vec!["a.bin"]
        );
        assert!(
            BodyPayload::Binary {
                file_path: String::new()
            }
            .sent_file_paths()
            .is_empty()
        );
    }

    #[test]
    fn maps_file_paths_and_keeps_text_fields() {
        let root = std::env::temp_dir().join("workspace");
        let payload = BodyPayload::FormData(vec![
            file_field("files/photo.png", true),
            FormDataField {
                name: "title".to_string(),
                enabled: true,
                value: FormDataFieldValue::Text("files/not-a-path".to_string()),
            },
        ]);

        let resolved = payload.map_file_paths(|path| resolve_file_path(&root, path));

        let BodyPayload::FormData(fields) = resolved else {
            panic!("expected form-data");
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
