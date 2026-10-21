//! Declarative forms and independent panel geometry for standard flows.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FlowFormFieldKind {
    #[default]
    Text,
    Textarea,
    Number,
    Select,
    Radio,
    Checkbox,
    Result,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FlowFormResultView {
    List,
    #[default]
    Table,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct FlowForm {
    pub title: String,
    pub description: String,
    pub sections: Vec<FlowFormSection>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct FlowFormSection {
    pub id: String,
    pub title: String,
    pub collapsed: bool,
    pub fields: Vec<FlowFormField>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct FlowFormField {
    pub id: String,
    pub label: String,
    pub description: String,
    pub kind: FlowFormFieldKind,
    pub required: bool,
    pub initial_value: String,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub step: Option<f64>,
    pub options: Vec<FlowFormOption>,
    pub source: Option<FlowFormSource>,
    pub multiple: bool,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct FlowFormOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct FlowFormSource {
    pub view: FlowFormResultView,
    pub reference: String,
    pub columns: Vec<FlowFormColumn>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct FlowFormColumn {
    pub path: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct FlowPanel {
    pub node_id: String,
    pub title: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct FlowPresentation {
    pub panels: Vec<FlowPanel>,
}
