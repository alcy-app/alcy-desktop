//! Visual themes for exported documents (ADR 0069). The app ships one default
//! theme; a downstream build registers more in its extension setup.
use serde::Serialize;
use std::{
    borrow::Cow,
    sync::{Arc, RwLock},
};

pub const DEFAULT_DOCUMENT_THEME: &str = "default";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ThemeColor(pub u8, pub u8, pub u8);

impl ThemeColor {
    pub fn hex(self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.0, self.1, self.2)
    }
    /// RGB components in 0–1, as PDF colors take them.
    pub fn unit(self) -> (f32, f32, f32) {
        (
            f32::from(self.0) / 255.0,
            f32::from(self.1) / 255.0,
            f32::from(self.2) / 255.0,
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentThemeColors {
    /// Links, rules, the cover band and the table of contents.
    pub accent: ThemeColor,
    pub heading: ThemeColor,
    pub text: ThemeColor,
    /// Captions, header, footer and metadata.
    pub muted: ThemeColor,
    pub border: ThemeColor,
    /// Code blocks, table headers and alternating rows.
    pub surface: ThemeColor,
}

/// TrueType faces; without `italic` faces the regular one is slanted.
#[derive(Debug, Clone)]
pub struct DocumentThemeFonts {
    pub regular: Cow<'static, [u8]>,
    pub bold: Cow<'static, [u8]>,
    pub italic: Option<Cow<'static, [u8]>>,
    pub bold_italic: Option<Cow<'static, [u8]>>,
}

#[derive(Debug, Clone)]
pub struct DocumentTheme {
    pub id: String,
    pub name: String,
    pub colors: DocumentThemeColors,
    /// Body faces; `None` uses the fonts bundled with the app.
    pub fonts: Option<DocumentThemeFonts>,
    /// PNG shown on the cover and in the page header.
    pub logo_png: Option<Cow<'static, [u8]>>,
    /// Right side of the page header, such as a classification.
    pub header_text: Option<String>,
    /// Left side of the page footer.
    pub footer_text: Option<String>,
}

impl DocumentTheme {
    pub fn default_theme() -> Self {
        Self {
            id: DEFAULT_DOCUMENT_THEME.into(),
            name: "Alcy".into(),
            colors: DocumentThemeColors {
                accent: ThemeColor(0x2f, 0x5b, 0xd8),
                heading: ThemeColor(0x14, 0x1b, 0x2d),
                text: ThemeColor(0x2b, 0x31, 0x40),
                muted: ThemeColor(0x6b, 0x72, 0x80),
                border: ThemeColor(0xd9, 0xdd, 0xe5),
                surface: ThemeColor(0xf4, 0xf6, 0xf9),
            },
            fonts: None,
            logo_png: None,
            header_text: None,
            footer_text: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentThemeSummary {
    pub id: String,
    pub name: String,
    pub accent: String,
}

/// Registered themes; the first one is the fallback for unknown ids.
#[derive(Clone)]
pub struct DocumentThemes(Arc<RwLock<Vec<Arc<DocumentTheme>>>>);

impl Default for DocumentThemes {
    fn default() -> Self {
        Self(Arc::new(RwLock::new(vec![Arc::new(
            DocumentTheme::default_theme(),
        )])))
    }
}

impl DocumentThemes {
    /// Adds a theme, or replaces the one with the same id.
    pub fn register(&self, theme: DocumentTheme) {
        let mut themes = self
            .0
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let theme = Arc::new(theme);
        match themes.iter().position(|existing| existing.id == theme.id) {
            Some(index) => themes[index] = theme,
            None => themes.push(theme),
        }
    }

    pub fn resolve(&self, id: Option<&str>) -> Arc<DocumentTheme> {
        let themes = self
            .0
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        id.and_then(|id| themes.iter().find(|theme| theme.id == id))
            .or_else(|| themes.first())
            .cloned()
            .unwrap_or_else(|| Arc::new(DocumentTheme::default_theme()))
    }

    pub fn summaries(&self) -> Vec<DocumentThemeSummary> {
        let themes = self
            .0
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        themes
            .iter()
            .map(|theme| DocumentThemeSummary {
                id: theme.id.clone(),
                name: theme.name.clone(),
                accent: theme.colors.accent.hex(),
            })
            .collect()
    }
}

/// Words the export writes itself, in the document's language.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentLabels {
    pub contents: &'static str,
    pub figure: &'static str,
    pub table: &'static str,
    pub page: &'static str,
    pub of: &'static str,
    pub author: &'static str,
    pub version: &'static str,
    pub date: &'static str,
    pub status: &'static str,
    pub note: &'static str,
    pub tip: &'static str,
    pub warning: &'static str,
    pub danger: &'static str,
}

impl DocumentLabels {
    /// Portuguese for `pt*` tags, English otherwise.
    pub fn for_language(language: &str) -> Self {
        if language.to_ascii_lowercase().starts_with("pt") {
            Self {
                contents: "Sumário",
                figure: "Figura",
                table: "Tabela",
                page: "Página",
                of: "de",
                author: "Autor",
                version: "Versão",
                date: "Data",
                status: "Status",
                note: "Nota",
                tip: "Dica",
                warning: "Atenção",
                danger: "Perigo",
            }
        } else {
            Self {
                contents: "Contents",
                figure: "Figure",
                table: "Table",
                page: "Page",
                of: "of",
                author: "Author",
                version: "Version",
                date: "Date",
                status: "Status",
                note: "Note",
                tip: "Tip",
                warning: "Warning",
                danger: "Danger",
            }
        }
    }
}

/// What an export needs besides the document: its theme and labels.
#[derive(Debug, Clone)]
pub struct DocumentExportOptions {
    pub theme: Arc<DocumentTheme>,
    pub labels: DocumentLabels,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_ids_fall_back_to_the_default_and_registration_replaces_by_id() {
        let themes = DocumentThemes::default();
        assert_eq!(themes.resolve(Some("missing")).id, DEFAULT_DOCUMENT_THEME);
        let mut internal = DocumentTheme::default_theme();
        internal.id = "internal".into();
        internal.name = "Internal".into();
        themes.register(internal.clone());
        internal.header_text = Some("Internal use".into());
        themes.register(internal);
        assert_eq!(themes.summaries().len(), 2);
        assert_eq!(
            themes.resolve(Some("internal")).header_text.as_deref(),
            Some("Internal use")
        );
        assert_eq!(themes.summaries()[0].accent, "#2f5bd8");
    }
}
