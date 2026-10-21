//! Serialized form and presentation contracts with lossless domain conversions.

use alcy_domain::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FlowFormResultViewConfig {
    List,
    #[default]
    Table,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FlowFormFieldKindConfig {
    #[default]
    Text,
    Textarea,
    Number,
    Select,
    Radio,
    Checkbox,
    Result,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FlowFormConfig {
    pub title: String,
    pub description: String,
    pub sections: Vec<FlowFormSectionConfig>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FlowFormSectionConfig {
    pub id: String,
    pub title: String,
    pub collapsed: bool,
    pub fields: Vec<FlowFormFieldConfig>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FlowFormFieldConfig {
    pub id: String,
    pub label: String,
    pub description: String,
    pub kind: FlowFormFieldKindConfig,
    pub required: bool,
    pub initial_value: String,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub step: Option<f64>,
    pub options: Vec<FlowFormOptionConfig>,
    pub source: Option<FlowFormSourceConfig>,
    pub multiple: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FlowFormOptionConfig {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FlowFormSourceConfig {
    pub view: FlowFormResultViewConfig,
    pub reference: String,
    pub columns: Vec<FlowFormColumnConfig>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FlowFormColumnConfig {
    pub path: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FlowPanelConfig {
    pub node_id: String,
    pub title: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FlowPresentationConfig {
    pub panels: Vec<FlowPanelConfig>,
}

impl From<FlowFormConfig> for FlowForm {
    fn from(value: FlowFormConfig) -> Self {
        Self {
            title: value.title,
            description: value.description,
            sections: value.sections.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<FlowForm> for FlowFormConfig {
    fn from(value: FlowForm) -> Self {
        Self {
            title: value.title,
            description: value.description,
            sections: value.sections.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<FlowFormSectionConfig> for FlowFormSection {
    fn from(value: FlowFormSectionConfig) -> Self {
        Self {
            id: value.id,
            title: value.title,
            collapsed: value.collapsed,
            fields: value.fields.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<FlowFormSection> for FlowFormSectionConfig {
    fn from(value: FlowFormSection) -> Self {
        Self {
            id: value.id,
            title: value.title,
            collapsed: value.collapsed,
            fields: value.fields.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<FlowFormFieldConfig> for FlowFormField {
    fn from(value: FlowFormFieldConfig) -> Self {
        Self {
            id: value.id,
            label: value.label,
            description: value.description,
            kind: match value.kind {
                FlowFormFieldKindConfig::Text => FlowFormFieldKind::Text,
                FlowFormFieldKindConfig::Textarea => FlowFormFieldKind::Textarea,
                FlowFormFieldKindConfig::Number => FlowFormFieldKind::Number,
                FlowFormFieldKindConfig::Select => FlowFormFieldKind::Select,
                FlowFormFieldKindConfig::Radio => FlowFormFieldKind::Radio,
                FlowFormFieldKindConfig::Checkbox => FlowFormFieldKind::Checkbox,
                FlowFormFieldKindConfig::Result => FlowFormFieldKind::Result,
            },
            required: value.required,
            initial_value: value.initial_value,
            min: value.min,
            max: value.max,
            step: value.step,
            options: value.options.into_iter().map(Into::into).collect(),
            source: value.source.map(Into::into),
            multiple: value.multiple,
        }
    }
}

impl From<FlowFormField> for FlowFormFieldConfig {
    fn from(value: FlowFormField) -> Self {
        Self {
            id: value.id,
            label: value.label,
            description: value.description,
            kind: match value.kind {
                FlowFormFieldKind::Text => FlowFormFieldKindConfig::Text,
                FlowFormFieldKind::Textarea => FlowFormFieldKindConfig::Textarea,
                FlowFormFieldKind::Number => FlowFormFieldKindConfig::Number,
                FlowFormFieldKind::Select => FlowFormFieldKindConfig::Select,
                FlowFormFieldKind::Radio => FlowFormFieldKindConfig::Radio,
                FlowFormFieldKind::Checkbox => FlowFormFieldKindConfig::Checkbox,
                FlowFormFieldKind::Result => FlowFormFieldKindConfig::Result,
            },
            required: value.required,
            initial_value: value.initial_value,
            min: value.min,
            max: value.max,
            step: value.step,
            options: value.options.into_iter().map(Into::into).collect(),
            source: value.source.map(Into::into),
            multiple: value.multiple,
        }
    }
}

impl From<FlowFormOptionConfig> for FlowFormOption {
    fn from(value: FlowFormOptionConfig) -> Self {
        Self {
            value: value.value,
            label: value.label,
        }
    }
}

impl From<FlowFormOption> for FlowFormOptionConfig {
    fn from(value: FlowFormOption) -> Self {
        Self {
            value: value.value,
            label: value.label,
        }
    }
}

impl From<FlowFormSourceConfig> for FlowFormSource {
    fn from(value: FlowFormSourceConfig) -> Self {
        Self {
            view: match value.view {
                FlowFormResultViewConfig::List => FlowFormResultView::List,
                FlowFormResultViewConfig::Table => FlowFormResultView::Table,
            },
            reference: value.reference,
            columns: value.columns.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<FlowFormSource> for FlowFormSourceConfig {
    fn from(value: FlowFormSource) -> Self {
        Self {
            view: match value.view {
                FlowFormResultView::List => FlowFormResultViewConfig::List,
                FlowFormResultView::Table => FlowFormResultViewConfig::Table,
            },
            reference: value.reference,
            columns: value.columns.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<FlowFormColumnConfig> for FlowFormColumn {
    fn from(value: FlowFormColumnConfig) -> Self {
        Self {
            path: value.path,
            label: value.label,
        }
    }
}

impl From<FlowFormColumn> for FlowFormColumnConfig {
    fn from(value: FlowFormColumn) -> Self {
        Self {
            path: value.path,
            label: value.label,
        }
    }
}

impl From<FlowPanelConfig> for FlowPanel {
    fn from(value: FlowPanelConfig) -> Self {
        Self {
            node_id: value.node_id,
            title: value.title,
            x: value.x,
            y: value.y,
            width: value.width,
            height: value.height,
        }
    }
}

impl From<FlowPanel> for FlowPanelConfig {
    fn from(value: FlowPanel) -> Self {
        Self {
            node_id: value.node_id,
            title: value.title,
            x: value.x,
            y: value.y,
            width: value.width,
            height: value.height,
        }
    }
}

impl From<FlowPresentationConfig> for FlowPresentation {
    fn from(value: FlowPresentationConfig) -> Self {
        Self {
            panels: value.panels.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<FlowPresentation> for FlowPresentationConfig {
    fn from(value: FlowPresentation) -> Self {
        Self {
            panels: value.panels.into_iter().map(Into::into).collect(),
        }
    }
}
