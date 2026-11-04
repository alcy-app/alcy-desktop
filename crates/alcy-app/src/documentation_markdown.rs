//! The document dialect (ADR 0069): Markdown plus a metadata block, `:::`
//! containers, page control, sized images and table captions. It becomes a
//! typed model for the PDF export and the agent outline. HTML stays literal text.
use pulldown_cmark::{Alignment, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde::Serialize;
use std::collections::BTreeMap;

/// Metadata keys the dialect understands, in the order they are written.
pub const DOCUMENT_METADATA_KEYS: [&str; 10] = [
    "subtitle",
    "author",
    "version",
    "date",
    "status",
    "theme",
    "lang",
    "cover",
    "toc",
    "numbering",
];
const MAX_METADATA_VALUE: usize = 200;
const MAX_COLUMNS: usize = 3;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    pub cover: bool,
    pub toc: bool,
    pub numbering: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum BlockAlign {
    #[default]
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CalloutKind {
    Note,
    Tip,
    Warning,
    Danger,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InlineRun {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub code: bool,
    pub strike: bool,
    pub link: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DocumentBlock {
    Heading {
        level: u8,
        number: Option<String>,
        runs: Vec<InlineRun>,
        align: BlockAlign,
    },
    Paragraph {
        runs: Vec<InlineRun>,
        align: BlockAlign,
    },
    List {
        ordered: bool,
        start: u64,
        items: Vec<Vec<DocumentBlock>>,
    },
    Quote(Vec<DocumentBlock>),
    Code {
        lang: Option<String>,
        text: String,
    },
    Table {
        align: Vec<BlockAlign>,
        header: Vec<Vec<InlineRun>>,
        rows: Vec<Vec<Vec<InlineRun>>>,
        caption: Option<String>,
        number: Option<u32>,
    },
    /// `width` is a fraction of the text column (0.1–1.0); without it the image keeps its size up to the column.
    Image {
        target: String,
        caption: String,
        number: Option<u32>,
        width: Option<f32>,
        align: BlockAlign,
    },
    Rule,
    Callout {
        kind: CalloutKind,
        title: Option<String>,
        blocks: Vec<DocumentBlock>,
    },
    Columns(Vec<Vec<DocumentBlock>>),
    PageBreak,
    Toc,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DocumentModel {
    pub meta: DocumentMeta,
    pub blocks: Vec<DocumentBlock>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineEntry {
    pub level: u8,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
}

// ---- Metadata block ----

/// The leading `---` block when every line in it is `key: value`, and the byte where the body starts.
pub fn split_front_matter(markdown: &str) -> Option<(Vec<(String, String)>, usize)> {
    let mut lines = markdown.split_inclusive('\n');
    let first = lines.next()?;
    if first.trim_end() != "---" {
        return None;
    }
    let mut offset = first.len();
    let mut pairs = Vec::new();
    for line in lines {
        offset += line.len();
        let text = line.trim_end();
        if text == "---" {
            return Some((pairs, offset));
        }
        if text.trim().is_empty() {
            continue;
        }
        let (key, value) = text.split_once(':')?;
        let key = key.trim();
        if key.is_empty()
            || !key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return None;
        }
        pairs.push((key.to_ascii_lowercase(), unquote(value.trim()).to_string()));
    }
    None
}

fn unquote(value: &str) -> &str {
    for quote in ['"', '\''] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            return &value[1..value.len() - 1];
        }
    }
    value
}

fn truthy(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "true" | "yes" | "sim" | "on" | "1"
    )
}

fn meta_from_pairs(pairs: &[(String, String)]) -> DocumentMeta {
    let mut meta = DocumentMeta::default();
    for (key, value) in pairs {
        let text = (!value.is_empty()).then(|| value.clone());
        match key.as_str() {
            "subtitle" => meta.subtitle = text,
            "author" => meta.author = text,
            "version" => meta.version = text,
            "date" => meta.date = text,
            "status" => meta.status = text,
            "theme" => meta.theme = text,
            "lang" => meta.lang = text,
            "cover" => meta.cover = truthy(value),
            "toc" => meta.toc = truthy(value),
            "numbering" => meta.numbering = truthy(value),
            _ => {}
        }
    }
    meta
}

/// Sets (`Some`) or removes (`None`) metadata keys, keeping unknown keys and the body untouched.
pub fn set_document_metadata(
    markdown: &str,
    patch: &BTreeMap<String, Option<String>>,
) -> Result<String, String> {
    let (mut pairs, body_start) = split_front_matter(markdown).unwrap_or((Vec::new(), 0));
    for (key, value) in patch {
        let key = key.to_ascii_lowercase();
        if !DOCUMENT_METADATA_KEYS.contains(&key.as_str()) {
            return Err(format!(
                "Unknown metadata key {key}. Use one of: {}.",
                DOCUMENT_METADATA_KEYS.join(", ")
            ));
        }
        let value = value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(value) = value
            && (value.len() > MAX_METADATA_VALUE || value.chars().any(char::is_control))
        {
            return Err(format!(
                "The {key} value must be one line of at most {MAX_METADATA_VALUE} bytes."
            ));
        }
        match (
            pairs.iter().position(|(existing, _)| *existing == key),
            value,
        ) {
            (Some(index), Some(value)) => pairs[index].1 = value.to_string(),
            (Some(index), None) => {
                pairs.remove(index);
            }
            (None, Some(value)) => {
                let order = |name: &str| {
                    DOCUMENT_METADATA_KEYS
                        .iter()
                        .position(|k| *k == name)
                        .unwrap_or(usize::MAX)
                };
                let at = pairs
                    .iter()
                    .position(|(existing, _)| order(existing) > order(&key))
                    .unwrap_or(pairs.len());
                pairs.insert(at, (key, value.to_string()));
            }
            (None, None) => {}
        }
    }
    let body = markdown[body_start..].trim_start_matches(['\n', '\r']);
    if pairs.is_empty() {
        return Ok(body.to_string());
    }
    let mut text = String::from("---\n");
    for (key, value) in &pairs {
        text.push_str(&format!("{key}: {value}\n"));
    }
    text.push_str("---\n\n");
    text.push_str(body);
    Ok(text)
}

// ---- Container scanner ----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContainerKind {
    Callout(CalloutKind),
    Columns,
    Align(BlockAlign),
}

#[derive(Debug)]
enum Segment {
    Markdown(String),
    Container {
        kind: ContainerKind,
        title: Option<String>,
        columns: Vec<Vec<Segment>>,
    },
    PageBreak,
    Toc,
    TableCaption(String),
}

fn container_kind(name: &str) -> Option<ContainerKind> {
    Some(match name.to_ascii_lowercase().as_str() {
        "note" | "info" => ContainerKind::Callout(CalloutKind::Note),
        "tip" | "success" => ContainerKind::Callout(CalloutKind::Tip),
        "warning" | "important" | "caution" => ContainerKind::Callout(CalloutKind::Warning),
        "danger" | "error" => ContainerKind::Callout(CalloutKind::Danger),
        "columns" => ContainerKind::Columns,
        "center" => ContainerKind::Align(BlockAlign::Center),
        "right" => ContainerKind::Align(BlockAlign::Right),
        _ => return None,
    })
}

/// A ```` ``` ```` or `~~~` fence opener: its character and length.
fn fence_open(line: &str) -> Option<(char, usize)> {
    let trimmed = line.trim_start_matches(' ');
    if line.len() - trimmed.len() > 3 {
        return None;
    }
    let marker = trimmed.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let length = trimmed.chars().take_while(|c| *c == marker).count();
    (length >= 3).then_some((marker, length))
}

fn fence_closes(line: &str, (marker, length): (char, usize)) -> bool {
    let trimmed = line.trim();
    trimmed.chars().take_while(|c| *c == marker).count() >= length
        && trimmed.chars().all(|c| c == marker)
}

struct OpenContainer {
    kind: ContainerKind,
    title: Option<String>,
    /// Finished columns; `current` is the one being filled.
    columns: Vec<Vec<Segment>>,
    current: Vec<Segment>,
}

impl OpenContainer {
    fn close(mut self) -> Segment {
        self.columns.push(self.current);
        Segment::Container {
            kind: self.kind,
            title: self.title,
            columns: self.columns,
        }
    }
}

fn scan(body: &str) -> Vec<Segment> {
    let mut root: Vec<Segment> = Vec::new();
    let mut stack: Vec<OpenContainer> = Vec::new();
    let mut buffer = String::new();
    let mut fence: Option<(char, usize)> = None;
    let mut last_line_was_table = false;

    fn target<'a>(
        root: &'a mut Vec<Segment>,
        stack: &'a mut [OpenContainer],
    ) -> &'a mut Vec<Segment> {
        match stack.last_mut() {
            Some(open) => &mut open.current,
            None => root,
        }
    }
    fn flush(buffer: &mut String, root: &mut Vec<Segment>, stack: &mut [OpenContainer]) {
        if !buffer.trim().is_empty() {
            target(root, stack).push(Segment::Markdown(std::mem::take(buffer)));
        }
        buffer.clear();
    }

    for line in body.split_inclusive('\n') {
        let text = line.trim_end_matches(['\n', '\r']);
        if let Some(open) = fence {
            if fence_closes(text, open) {
                fence = None;
            }
            buffer.push_str(line);
            continue;
        }
        if let Some(open) = fence_open(text) {
            fence = Some(open);
            buffer.push_str(line);
            last_line_was_table = false;
            continue;
        }
        let trimmed = text.trim();
        if let Some(rest) = trimmed.strip_prefix(":::") {
            let rest = rest.trim();
            if rest.is_empty() {
                if !stack.is_empty() {
                    flush(&mut buffer, &mut root, &mut stack);
                    if let Some(open) = stack.pop() {
                        target(&mut root, &mut stack).push(open.close());
                    }
                    last_line_was_table = false;
                    continue;
                }
            } else {
                let (name, title) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
                if let Some(kind) = container_kind(name) {
                    flush(&mut buffer, &mut root, &mut stack);
                    let title = title.trim();
                    stack.push(OpenContainer {
                        kind,
                        title: (!title.is_empty()).then(|| title.to_string()),
                        columns: Vec::new(),
                        current: Vec::new(),
                    });
                    last_line_was_table = false;
                    continue;
                }
            }
        }
        if trimmed == "+++"
            && let Some(open) = stack.last()
            && open.kind == ContainerKind::Columns
            && open.columns.len() + 1 < MAX_COLUMNS
        {
            flush(&mut buffer, &mut root, &mut stack);
            if let Some(open) = stack.last_mut() {
                let finished = std::mem::take(&mut open.current);
                open.columns.push(finished);
            }
            continue;
        }
        if trimmed == "\\pagebreak" || trimmed.eq_ignore_ascii_case("[[toc]]") {
            flush(&mut buffer, &mut root, &mut stack);
            target(&mut root, &mut stack).push(if trimmed == "\\pagebreak" {
                Segment::PageBreak
            } else {
                Segment::Toc
            });
            last_line_was_table = false;
            continue;
        }
        if last_line_was_table && let Some(caption) = trimmed.strip_prefix("Table:") {
            flush(&mut buffer, &mut root, &mut stack);
            target(&mut root, &mut stack).push(Segment::TableCaption(caption.trim().to_string()));
            last_line_was_table = false;
            continue;
        }
        if !trimmed.is_empty() {
            last_line_was_table = trimmed.starts_with('|') || trimmed.ends_with('|');
        }
        buffer.push_str(line);
    }
    flush(&mut buffer, &mut root, &mut stack);
    // Unclosed containers end with the document.
    while let Some(open) = stack.pop() {
        let segment = open.close();
        target(&mut root, &mut stack).push(segment);
    }
    root
}

// ---- Markdown chunks ----

#[derive(Debug)]
enum Inline {
    Run(InlineRun),
    Image {
        target: String,
        caption: String,
        width: Option<f32>,
        align: Option<BlockAlign>,
    },
}

#[derive(Default, Clone, Copy)]
struct Style {
    bold: u32,
    italic: u32,
    strike: u32,
}

enum Frame {
    Quote(Vec<DocumentBlock>),
    List {
        ordered: bool,
        start: u64,
        items: Vec<Vec<DocumentBlock>>,
    },
    Item(Vec<DocumentBlock>),
}

struct Builder {
    root: Vec<DocumentBlock>,
    frames: Vec<Frame>,
    inline: Option<Vec<Inline>>,
    heading: Option<u8>,
    style: Style,
    links: Vec<String>,
    image: Option<(String, String)>,
    pending_attributes: bool,
    code: Option<(Option<String>, String)>,
    table: Option<TableBuilder>,
    align: BlockAlign,
}

struct TableBuilder {
    align: Vec<BlockAlign>,
    header: Vec<Vec<InlineRun>>,
    rows: Vec<Vec<Vec<InlineRun>>>,
    row: Vec<Vec<InlineRun>>,
    cell: Option<Vec<Inline>>,
    in_head: bool,
}

impl Builder {
    fn new(align: BlockAlign) -> Self {
        Self {
            root: Vec::new(),
            frames: Vec::new(),
            inline: None,
            heading: None,
            style: Style::default(),
            links: Vec::new(),
            image: None,
            pending_attributes: false,
            code: None,
            table: None,
            align,
        }
    }

    fn push_block(&mut self, block: DocumentBlock) {
        match self.frames.last_mut() {
            Some(Frame::Quote(blocks) | Frame::Item(blocks)) => blocks.push(block),
            // Content directly inside a list (never produced by the parser) becomes its own item.
            Some(Frame::List { items, .. }) => items.push(vec![block]),
            None => self.root.push(block),
        }
    }

    fn inline_target(&mut self) -> &mut Vec<Inline> {
        if let Some(table) = &mut self.table {
            return table.cell.get_or_insert_with(Vec::new);
        }
        // Tight list items carry their text without a paragraph.
        self.inline.get_or_insert_with(Vec::new)
    }

    fn text(&mut self, text: &str, code: bool) {
        let mut text = text;
        if self.pending_attributes && !code {
            self.pending_attributes = false;
            if let Some((attributes, rest)) = parse_image_attributes(text) {
                if let Some(Inline::Image { width, align, .. }) = self.inline_target().last_mut() {
                    *width = attributes.0;
                    *align = attributes.1;
                }
                text = rest;
            }
        }
        if text.is_empty() {
            return;
        }
        if let Some((_, caption)) = &mut self.image {
            caption.push_str(text);
            return;
        }
        let run = InlineRun {
            text: text.to_string(),
            bold: self.style.bold > 0,
            italic: self.style.italic > 0,
            strike: self.style.strike > 0,
            code,
            link: self.links.last().cloned(),
        };
        let target = self.inline_target();
        if let Some(Inline::Run(last)) = target.last_mut()
            && last.bold == run.bold
            && last.italic == run.italic
            && last.strike == run.strike
            && last.code == run.code
            && last.link == run.link
        {
            last.text.push_str(&run.text);
        } else {
            target.push(Inline::Run(run));
        }
    }

    /// Ends the open paragraph or heading; images on their own become image blocks.
    fn flush_inline(&mut self) {
        // Attributes must follow the image directly.
        self.pending_attributes = false;
        let Some(items) = self.inline.take() else {
            return;
        };
        let align = self.align;
        let heading = self.heading.take();
        let mut runs: Vec<InlineRun> = Vec::new();
        let mut blocks = Vec::new();
        let push_runs = |runs: &mut Vec<InlineRun>, blocks: &mut Vec<DocumentBlock>| {
            trim_runs(runs);
            if runs.iter().any(|run| !run.text.trim().is_empty()) {
                let runs = std::mem::take(runs);
                blocks.push(match heading {
                    Some(level) => DocumentBlock::Heading {
                        level,
                        number: None,
                        runs,
                        align,
                    },
                    None => DocumentBlock::Paragraph { runs, align },
                });
            }
            runs.clear();
        };
        for item in items {
            match item {
                Inline::Run(run) => runs.push(run),
                Inline::Image {
                    target,
                    caption,
                    width,
                    align: image_align,
                } => {
                    push_runs(&mut runs, &mut blocks);
                    blocks.push(DocumentBlock::Image {
                        target,
                        caption: caption.trim().to_string(),
                        number: None,
                        width,
                        align: image_align.unwrap_or(if align == BlockAlign::Left {
                            BlockAlign::Center
                        } else {
                            align
                        }),
                    });
                }
            }
        }
        push_runs(&mut runs, &mut blocks);
        for block in blocks {
            self.push_block(block);
        }
    }

    fn event(&mut self, event: Event<'_>) {
        if let Some((_, text)) = &mut self.code {
            match event {
                Event::Text(value) => text.push_str(&value),
                Event::End(TagEnd::CodeBlock) => {
                    if let Some((lang, text)) = self.code.take() {
                        self.push_block(DocumentBlock::Code {
                            lang,
                            text: text.trim_end_matches('\n').to_string(),
                        });
                    }
                }
                _ => {}
            }
            return;
        }
        match event {
            Event::Start(Tag::Paragraph) => self.inline = Some(Vec::new()),
            Event::End(TagEnd::Paragraph) => self.flush_inline(),
            Event::Start(Tag::Heading { level, .. }) => {
                self.flush_inline();
                self.heading = Some(heading_level(level));
                self.inline = Some(Vec::new());
            }
            Event::End(TagEnd::Heading(_)) => self.flush_inline(),
            Event::Start(Tag::BlockQuote(_)) => {
                self.flush_inline();
                self.frames.push(Frame::Quote(Vec::new()));
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                self.flush_inline();
                if let Some(Frame::Quote(blocks)) = self.frames.pop() {
                    self.push_block(DocumentBlock::Quote(blocks));
                }
            }
            Event::Start(Tag::List(start)) => {
                self.flush_inline();
                self.frames.push(Frame::List {
                    ordered: start.is_some(),
                    start: start.unwrap_or(1),
                    items: Vec::new(),
                });
            }
            Event::End(TagEnd::List(_)) => {
                self.flush_inline();
                if let Some(Frame::List {
                    ordered,
                    start,
                    items,
                }) = self.frames.pop()
                {
                    self.push_block(DocumentBlock::List {
                        ordered,
                        start,
                        items,
                    });
                }
            }
            Event::Start(Tag::Item) => self.frames.push(Frame::Item(Vec::new())),
            Event::End(TagEnd::Item) => {
                self.flush_inline();
                if let Some(Frame::Item(blocks)) = self.frames.pop()
                    && let Some(Frame::List { items, .. }) = self.frames.last_mut()
                {
                    items.push(blocks);
                }
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                self.flush_inline();
                let lang = match kind {
                    CodeBlockKind::Fenced(info) => {
                        info.split_whitespace().next().map(str::to_ascii_lowercase)
                    }
                    CodeBlockKind::Indented => None,
                };
                self.code = Some((lang, String::new()));
            }
            Event::Start(Tag::Table(alignments)) => {
                self.flush_inline();
                self.table = Some(TableBuilder {
                    align: alignments
                        .iter()
                        .map(|a| match a {
                            Alignment::Center => BlockAlign::Center,
                            Alignment::Right => BlockAlign::Right,
                            _ => BlockAlign::Left,
                        })
                        .collect(),
                    header: Vec::new(),
                    rows: Vec::new(),
                    row: Vec::new(),
                    cell: None,
                    in_head: false,
                });
            }
            Event::Start(Tag::TableHead) => {
                if let Some(table) = &mut self.table {
                    table.in_head = true;
                }
            }
            Event::Start(Tag::TableCell) => {
                if let Some(table) = &mut self.table {
                    table.cell = Some(Vec::new());
                }
            }
            Event::End(TagEnd::TableCell) => {
                if let Some(table) = &mut self.table {
                    let mut runs = runs_only(table.cell.take().unwrap_or_default());
                    trim_runs(&mut runs);
                    table.row.push(runs);
                }
            }
            Event::End(TagEnd::TableHead) => {
                if let Some(table) = &mut self.table {
                    table.header = std::mem::take(&mut table.row);
                    table.in_head = false;
                }
            }
            Event::End(TagEnd::TableRow) => {
                if let Some(table) = &mut self.table {
                    let row = std::mem::take(&mut table.row);
                    if table.in_head {
                        table.header = row;
                    } else {
                        table.rows.push(row);
                    }
                }
            }
            Event::End(TagEnd::Table) => {
                if let Some(table) = self.table.take() {
                    self.push_block(DocumentBlock::Table {
                        align: table.align,
                        header: table.header,
                        rows: table.rows,
                        caption: None,
                        number: None,
                    });
                }
            }
            Event::Start(Tag::Emphasis) => self.style.italic += 1,
            Event::End(TagEnd::Emphasis) => self.style.italic = self.style.italic.saturating_sub(1),
            Event::Start(Tag::Strong) => self.style.bold += 1,
            Event::End(TagEnd::Strong) => self.style.bold = self.style.bold.saturating_sub(1),
            Event::Start(Tag::Strikethrough) => self.style.strike += 1,
            Event::End(TagEnd::Strikethrough) => {
                self.style.strike = self.style.strike.saturating_sub(1)
            }
            Event::Start(Tag::Link { dest_url, .. }) => {
                let url = dest_url.into_string();
                // Only web links survive; other schemes keep their text.
                self.links.push(
                    if url.starts_with("https://") || url.starts_with("http://") {
                        url
                    } else {
                        String::new()
                    },
                );
            }
            Event::End(TagEnd::Link) => {
                self.links.pop();
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                self.image = Some((dest_url.into_string(), String::new()))
            }
            Event::End(TagEnd::Image) => {
                if let Some((target, caption)) = self.image.take() {
                    if self.table.is_some() {
                        self.text(&caption, false);
                    } else {
                        self.inline_target().push(Inline::Image {
                            target,
                            caption,
                            width: None,
                            align: None,
                        });
                        self.pending_attributes = true;
                    }
                }
            }
            Event::Text(value) | Event::Html(value) | Event::InlineHtml(value) => {
                self.text(&value, false)
            }
            Event::Code(value) => self.text(&value, true),
            Event::SoftBreak => self.text(" ", false),
            Event::HardBreak => self.text("\n", false),
            Event::Rule => {
                self.flush_inline();
                self.push_block(DocumentBlock::Rule);
            }
            _ => {}
        }
    }

    fn finish(mut self) -> Vec<DocumentBlock> {
        self.flush_inline();
        while let Some(frame) = self.frames.pop() {
            let block = match frame {
                Frame::Quote(blocks) => DocumentBlock::Quote(blocks),
                Frame::List {
                    ordered,
                    start,
                    items,
                } => DocumentBlock::List {
                    ordered,
                    start,
                    items,
                },
                Frame::Item(blocks) => DocumentBlock::List {
                    ordered: false,
                    start: 1,
                    items: vec![blocks],
                },
            };
            self.push_block(block);
        }
        self.root
    }
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn runs_only(items: Vec<Inline>) -> Vec<InlineRun> {
    items
        .into_iter()
        .map(|item| match item {
            Inline::Run(run) => run,
            Inline::Image { caption, .. } => InlineRun {
                text: caption,
                ..Default::default()
            },
        })
        .collect()
}

fn trim_runs(runs: &mut Vec<InlineRun>) {
    if let Some(first) = runs.first_mut() {
        first.text = first.text.trim_start().to_string();
    }
    if let Some(last) = runs.last_mut() {
        last.text = last.text.trim_end().to_string();
    }
    runs.retain(|run| !run.text.is_empty());
}

/// Width fraction and alignment written after an image.
type ImageAttributes = (Option<f32>, Option<BlockAlign>);

/// `{width=50% align=center}` right after an image; returns the attributes and the remaining text.
fn parse_image_attributes(text: &str) -> Option<(ImageAttributes, &str)> {
    let inner = text.strip_prefix('{')?;
    let close = inner.find('}')?;
    let mut width = None;
    let mut align = None;
    for pair in inner[..close].split_whitespace() {
        let (key, value) = pair.split_once('=')?;
        match key {
            "width" => {
                let percent: f32 = value.trim_end_matches('%').parse().ok()?;
                width = Some((percent / 100.0).clamp(0.1, 1.0));
            }
            "align" => {
                align = Some(match value {
                    "left" => BlockAlign::Left,
                    "center" => BlockAlign::Center,
                    "right" => BlockAlign::Right,
                    _ => return None,
                })
            }
            _ => return None,
        }
    }
    Some(((width, align), &inner[close + 1..]))
}

fn parse_chunk(markdown: &str, align: BlockAlign) -> Vec<DocumentBlock> {
    let mut builder = Builder::new(align);
    for event in Parser::new_ext(
        markdown,
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH,
    ) {
        builder.event(event);
    }
    builder.finish()
}

fn convert(
    segments: Vec<Segment>,
    align: BlockAlign,
    in_columns: bool,
    out: &mut Vec<DocumentBlock>,
) {
    for segment in segments {
        match segment {
            Segment::Markdown(text) => out.extend(parse_chunk(&text, align)),
            Segment::PageBreak => out.push(DocumentBlock::PageBreak),
            Segment::Toc => out.push(DocumentBlock::Toc),
            Segment::TableCaption(caption) => match out.last_mut() {
                Some(DocumentBlock::Table {
                    caption: slot @ None,
                    ..
                }) => *slot = Some(caption),
                _ => out.push(DocumentBlock::Paragraph {
                    runs: vec![InlineRun {
                        text: format!("Table: {caption}"),
                        ..Default::default()
                    }],
                    align,
                }),
            },
            Segment::Container {
                kind,
                title,
                columns,
            } => match kind {
                ContainerKind::Callout(kind) => {
                    let mut blocks = Vec::new();
                    for column in columns {
                        convert(column, BlockAlign::Left, in_columns, &mut blocks);
                    }
                    out.push(DocumentBlock::Callout {
                        kind,
                        title,
                        blocks,
                    });
                }
                // Columns inside columns stack their content.
                ContainerKind::Columns if in_columns => {
                    for column in columns {
                        convert(column, align, true, out);
                    }
                }
                ContainerKind::Columns => {
                    let columns = columns
                        .into_iter()
                        .map(|column| {
                            let mut blocks = Vec::new();
                            convert(column, align, true, &mut blocks);
                            blocks
                        })
                        .filter(|blocks| !blocks.is_empty())
                        .collect::<Vec<_>>();
                    match columns.len() {
                        0 => {}
                        1 => out.extend(columns.into_iter().flatten()),
                        _ => out.push(DocumentBlock::Columns(columns)),
                    }
                }
                ContainerKind::Align(inner) => {
                    for column in columns {
                        convert(column, inner, in_columns, out);
                    }
                }
            },
        }
    }
}

#[derive(Default)]
struct Counters {
    headings: [u32; 3],
    figures: u32,
    tables: u32,
}

fn number(blocks: &mut [DocumentBlock], numbering: bool, counters: &mut Counters) {
    for block in blocks {
        match block {
            DocumentBlock::Heading { level, number, .. } if numbering && *level <= 3 => {
                let index = usize::from(*level - 1);
                counters.headings[index] += 1;
                for deeper in counters.headings.iter_mut().skip(index + 1) {
                    *deeper = 0;
                }
                let parts = counters.headings[..=index]
                    .iter()
                    .map(|n| n.max(&1).to_string())
                    .collect::<Vec<_>>();
                *number = Some(parts.join("."));
            }
            DocumentBlock::Image {
                caption, number, ..
            } if !caption.is_empty() => {
                counters.figures += 1;
                *number = Some(counters.figures);
            }
            DocumentBlock::Table {
                caption: Some(_),
                number,
                ..
            } => {
                counters.tables += 1;
                *number = Some(counters.tables);
            }
            DocumentBlock::List { items, .. } | DocumentBlock::Columns(items) => {
                for item in items {
                    number(item, numbering, counters);
                }
            }
            DocumentBlock::Quote(blocks) | DocumentBlock::Callout { blocks, .. } => {
                number(blocks, numbering, counters)
            }
            _ => {}
        }
    }
}

pub fn parse_document(markdown: &str) -> DocumentModel {
    let (meta, body) = match split_front_matter(markdown) {
        Some((pairs, start)) => (meta_from_pairs(&pairs), &markdown[start..]),
        None => (DocumentMeta::default(), markdown),
    };
    let mut blocks = Vec::new();
    convert(scan(body), BlockAlign::Left, false, &mut blocks);
    number(&mut blocks, meta.numbering, &mut Counters::default());
    DocumentModel { meta, blocks }
}

pub fn plain_text(runs: &[InlineRun]) -> String {
    runs.iter().map(|run| run.text.as_str()).collect()
}

/// Headings in document order, with their automatic numbers.
pub fn document_outline(model: &DocumentModel) -> Vec<OutlineEntry> {
    fn walk(blocks: &[DocumentBlock], out: &mut Vec<OutlineEntry>) {
        for block in blocks {
            match block {
                DocumentBlock::Heading {
                    level,
                    number,
                    runs,
                    ..
                } => out.push(OutlineEntry {
                    level: *level,
                    text: plain_text(runs),
                    number: number.clone(),
                }),
                DocumentBlock::Columns(items) | DocumentBlock::List { items, .. } => {
                    items.iter().for_each(|item| walk(item, out))
                }
                DocumentBlock::Quote(blocks) | DocumentBlock::Callout { blocks, .. } => {
                    walk(blocks, out)
                }
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(&model.blocks, &mut out);
    out
}

// ---- Section edits ----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SectionEdit {
    /// Replaces the heading and everything up to the next heading of the same or a higher level.
    Replace,
    /// Before the heading.
    InsertBefore,
    /// After the section and its subsections.
    InsertAfter,
    /// At the end of the section's own text, before its first subsection.
    AppendToSection,
}

impl SectionEdit {
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "replace" => Self::Replace,
            "insertBefore" => Self::InsertBefore,
            "insertAfter" => Self::InsertAfter,
            "appendToSection" => Self::AppendToSection,
            _ => return None,
        })
    }
}

struct HeadingLine {
    start: usize,
    end: usize,
    level: usize,
    text: String,
}

fn atx_heading(line: &str) -> Option<(usize, String)> {
    let trimmed = line.trim_start_matches(' ');
    if line.len() - trimmed.len() > 3 {
        return None;
    }
    let level = trimmed.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let rest = &trimmed[level..];
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None;
    }
    let text = rest.trim().trim_end_matches('#').trim();
    Some((level, text.to_string()))
}

fn heading_lines(markdown: &str) -> Vec<HeadingLine> {
    let body_start = split_front_matter(markdown).map_or(0, |(_, start)| start);
    let mut headings = Vec::new();
    let mut fence = None;
    let mut offset = body_start;
    for line in markdown[body_start..].split_inclusive('\n') {
        let text = line.trim_end_matches(['\n', '\r']);
        if let Some(open) = fence {
            if fence_closes(text, open) {
                fence = None;
            }
        } else if let Some(open) = fence_open(text) {
            fence = Some(open);
        } else if let Some((level, text)) = atx_heading(text) {
            headings.push(HeadingLine {
                start: offset,
                end: offset + line.len(),
                level,
                text,
            });
        }
        offset += line.len();
    }
    headings
}

fn normalize_heading(text: &str) -> String {
    text.trim_start_matches('#')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Joins text with exactly one blank line around the inserted content.
fn splice(markdown: &str, at: usize, until: usize, content: &str) -> String {
    let before = markdown[..at].trim_end_matches(['\n', ' ', '\t']);
    let after = markdown[until..].trim_start_matches('\n');
    let content = content.trim_matches('\n');
    let mut text = String::with_capacity(markdown.len() + content.len() + 4);
    text.push_str(before);
    if !before.is_empty() && !content.is_empty() {
        text.push_str("\n\n");
    }
    text.push_str(content);
    if !after.is_empty() {
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str(after);
    } else if !text.is_empty() {
        text.push('\n');
    }
    text
}

/// Edits the section under the unique heading `section` (its text, with or without `#`).
pub fn edit_document_section(
    markdown: &str,
    section: &str,
    edit: SectionEdit,
    content: &str,
) -> Result<String, String> {
    let wanted = normalize_heading(section);
    if wanted.is_empty() {
        return Err("Name the section by its heading text.".into());
    }
    let headings = heading_lines(markdown);
    let matches = headings
        .iter()
        .enumerate()
        .filter(|(_, h)| normalize_heading(&h.text) == wanted)
        .collect::<Vec<_>>();
    let (index, heading) = match matches.as_slice() {
        [single] => *single,
        [] => {
            let available = headings
                .iter()
                .take(40)
                .map(|h| format!("{} {}", "#".repeat(h.level), h.text))
                .collect::<Vec<_>>()
                .join("; ");
            return Err(format!(
                "No heading matches \"{section}\". Headings: {available}"
            ));
        }
        many => {
            return Err(format!(
                "{} headings match \"{section}\"; rename one or use replaceText.",
                many.len()
            ));
        }
    };
    let section_end = headings[index + 1..]
        .iter()
        .find(|h| h.level <= heading.level)
        .map_or(markdown.len(), |h| h.start);
    let body_end = headings
        .get(index + 1)
        .map_or(markdown.len(), |h| h.start)
        .min(section_end);
    Ok(match edit {
        SectionEdit::Replace => splice(markdown, heading.start, section_end, content),
        SectionEdit::InsertBefore => splice(markdown, heading.start, heading.start, content),
        SectionEdit::InsertAfter => splice(markdown, section_end, section_end, content),
        SectionEdit::AppendToSection => {
            if markdown[heading.end..body_end].trim().is_empty() {
                splice(markdown, heading.end, body_end, content)
            } else {
                splice(markdown, body_end, body_end, content)
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_of(block: &DocumentBlock) -> String {
        match block {
            DocumentBlock::Heading { runs, .. } | DocumentBlock::Paragraph { runs, .. } => {
                plain_text(runs)
            }
            _ => String::new(),
        }
    }

    #[test]
    fn procedure_numbering_and_code_are_preserved() {
        let model = parse_document("3. Connect\n4. Send\n\n```http\nGET /users\n```\n");
        let DocumentBlock::List {
            ordered: true,
            start: 3,
            items,
        } = &model.blocks[0]
        else {
            panic!("{:?}", model.blocks)
        };
        assert_eq!(text_of(&items[1][0]), "Send");
        assert_eq!(
            model.blocks[1],
            DocumentBlock::Code {
                lang: Some("http".into()),
                text: "GET /users".into()
            }
        );
    }

    #[test]
    fn inline_styles_become_runs() {
        let model = parse_document(
            "Use **bold**, _italic_, `code`, ~~old~~ and [docs](https://example.com).",
        );
        let DocumentBlock::Paragraph { runs, .. } = &model.blocks[0] else {
            panic!()
        };
        assert!(runs.iter().any(|r| r.text == "bold" && r.bold));
        assert!(runs.iter().any(|r| r.text == "italic" && r.italic));
        assert!(runs.iter().any(|r| r.text == "code" && r.code));
        assert!(runs.iter().any(|r| r.text == "old" && r.strike));
        assert!(
            runs.iter()
                .any(|r| r.text == "docs" && r.link.as_deref() == Some("https://example.com"))
        );
    }

    #[test]
    fn metadata_block_needs_key_value_lines() {
        let model = parse_document(
            "---\nsubtitle: API v2\nauthor: \"Ana\"\ncover: true\nnumbering: sim\n---\n\n# Intro\n",
        );
        assert_eq!(model.meta.subtitle.as_deref(), Some("API v2"));
        assert_eq!(model.meta.author.as_deref(), Some("Ana"));
        assert!(model.meta.cover && model.meta.numbering && !model.meta.toc);
        // A leading rule followed by prose stays Markdown.
        let prose = parse_document("---\nNot metadata here.\n---\n");
        assert_eq!(prose.meta, DocumentMeta::default());
        assert!(!prose.blocks.is_empty());
    }

    #[test]
    fn containers_columns_and_page_control() {
        let model = parse_document(
            ":::warning Rate limit\nKeep **under** 10 rps.\n:::\n\n:::columns\nLeft\n+++\nRight\n:::\n\n\\pagebreak\n[[toc]]\n\n:::center\nCentered\n:::\n",
        );
        let DocumentBlock::Callout {
            kind: CalloutKind::Warning,
            title,
            blocks,
        } = &model.blocks[0]
        else {
            panic!("{:?}", model.blocks)
        };
        assert_eq!(title.as_deref(), Some("Rate limit"));
        assert_eq!(text_of(&blocks[0]), "Keep under 10 rps.");
        let DocumentBlock::Columns(columns) = &model.blocks[1] else {
            panic!()
        };
        assert_eq!(
            (text_of(&columns[0][0]), text_of(&columns[1][0])),
            ("Left".into(), "Right".into())
        );
        assert_eq!(model.blocks[2], DocumentBlock::PageBreak);
        assert_eq!(model.blocks[3], DocumentBlock::Toc);
        assert!(matches!(
            &model.blocks[4],
            DocumentBlock::Paragraph {
                align: BlockAlign::Center,
                ..
            }
        ));
    }

    #[test]
    fn container_markers_inside_code_stay_code() {
        let model = parse_document("```text\n:::note\n\\pagebreak\n```\n");
        assert_eq!(
            model.blocks,
            vec![DocumentBlock::Code {
                lang: Some("text".into()),
                text: ":::note\n\\pagebreak".into()
            }]
        );
    }

    #[test]
    fn images_tables_and_headings_are_numbered() {
        let asset = format!("assets/{}.png", "a".repeat(64));
        let markdown = format!(
            "---\nnumbering: true\n---\n# One\n## Sub\n# Two\n\n![Login]({asset}){{width=50% align=right}}\n\n| A | B |\n|---|--:|\n| 1 | 2 |\nTable: Results\n\n![]({asset})\n"
        );
        let model = parse_document(&markdown);
        let outline = document_outline(&model);
        assert_eq!(
            outline
                .iter()
                .map(|e| e.number.clone().unwrap_or_default())
                .collect::<Vec<_>>(),
            ["1", "1.1", "2"]
        );
        assert_eq!(
            model.blocks[3],
            DocumentBlock::Image {
                target: asset.clone(),
                caption: "Login".into(),
                number: Some(1),
                width: Some(0.5),
                align: BlockAlign::Right
            }
        );
        let DocumentBlock::Table {
            caption,
            number,
            align,
            ..
        } = &model.blocks[4]
        else {
            panic!("{:?}", model.blocks)
        };
        assert_eq!((caption.as_deref(), *number), (Some("Results"), Some(1)));
        assert_eq!(align, &[BlockAlign::Left, BlockAlign::Right]);
        assert!(matches!(
            &model.blocks[5],
            DocumentBlock::Image {
                number: None,
                align: BlockAlign::Center,
                ..
            }
        ));
    }

    #[test]
    fn metadata_edits_keep_body_and_unknown_keys() {
        let patch = BTreeMap::from([
            ("author".to_string(), Some("Ana".to_string())),
            ("cover".to_string(), Some("true".to_string())),
        ]);
        let text = set_document_metadata("# Body\n", &patch).unwrap();
        assert_eq!(text, "---\nauthor: Ana\ncover: true\n---\n\n# Body\n");
        let text = set_document_metadata(
            "---\nowner: ops\nauthor: Ana\n---\n\n# Body\n",
            &BTreeMap::from([("author".to_string(), None)]),
        )
        .unwrap();
        assert_eq!(text, "---\nowner: ops\n---\n\n# Body\n");
        assert!(
            set_document_metadata(
                "",
                &BTreeMap::from([("color".to_string(), Some("red".to_string()))])
            )
            .is_err()
        );
        assert_eq!(
            set_document_metadata(
                "---\nauthor: Ana\n---\n\nText",
                &BTreeMap::from([("author".to_string(), None)])
            )
            .unwrap(),
            "Text"
        );
    }

    #[test]
    fn section_edits_target_unique_headings() {
        let doc = "# Guide\n\nIntro.\n\n## Auth\n\nOld auth.\n\n### Tokens\n\nDetails.\n\n## Errors\n\nList.\n";
        assert_eq!(
            edit_document_section(doc, "## auth", SectionEdit::Replace, "## Auth\n\nNew auth.")
                .unwrap(),
            "# Guide\n\nIntro.\n\n## Auth\n\nNew auth.\n\n## Errors\n\nList.\n"
        );
        assert_eq!(
            edit_document_section(doc, "Auth", SectionEdit::AppendToSection, "More.").unwrap(),
            "# Guide\n\nIntro.\n\n## Auth\n\nOld auth.\n\nMore.\n\n### Tokens\n\nDetails.\n\n## Errors\n\nList.\n"
        );
        assert_eq!(
            edit_document_section(
                doc,
                "Errors",
                SectionEdit::InsertAfter,
                "## Limits\n\n100 rps."
            )
            .unwrap(),
            format!("{}\n## Limits\n\n100 rps.\n", doc)
        );
        assert!(
            edit_document_section(doc, "Errors", SectionEdit::InsertBefore, "## Setup")
                .unwrap()
                .contains("Details.\n\n## Setup\n\n## Errors")
        );
        assert!(
            edit_document_section(doc, "Missing", SectionEdit::Replace, "")
                .unwrap_err()
                .contains("## Auth")
        );
        assert!(edit_document_section("# A\n# A\n", "A", SectionEdit::Replace, "").is_err());
        // Headings inside code fences are not sections.
        assert!(
            edit_document_section("```md\n# Fake\n```\n", "Fake", SectionEdit::Replace, "")
                .is_err()
        );
    }
}
