//! Native PDF layout for the document dialect (ADR 0069): themed typography,
//! cover, table of contents, callouts, columns, tables, code and images, with
//! embedded fonts, selectable text, links and bookmarks.
use crate::DocumentationStore;
use alcy_app::{
    BlockAlign, CalloutKind, DocumentBlock, DocumentExportOptions, DocumentLabels, DocumentModel,
    DocumentResult, DocumentTheme, DocumentationError, DocumentationRecord, InlineRun, ThemeColor,
    document_invalid, document_outline, parse_document,
};
use printpdf::*;
use std::{
    collections::HashMap,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

const PAGE_W: f32 = 595.28;
const PAGE_H: f32 = 841.89;
const MARGIN_X: f32 = 56.0;
const CONTENT_W: f32 = PAGE_W - 2.0 * MARGIN_X;
const TOP: f32 = PAGE_H - 74.0;
const BOTTOM: f32 = 66.0;
const BODY_SIZE: f32 = 10.5;
const LINE: f32 = 1.5;
const MAX_PAGES: usize = 200;
const IMAGE_BUDGET: u64 = 256 * 1024 * 1024;
/// Shear for faces without a true italic.
const SLANT: f32 = 0.2;
const WHITE: ThemeColor = ThemeColor(255, 255, 255);

fn cancelled(flag: &AtomicBool) -> DocumentResult<()> {
    if flag.load(Ordering::Relaxed) {
        Err(DocumentationError::Cancelled)
    } else {
        Ok(())
    }
}
fn failure(message: impl Into<String>) -> DocumentationError {
    DocumentationError::Storage(message.into())
}
fn color(c: ThemeColor) -> Color {
    let (r, g, b) = c.unit();
    Color::Rgb(Rgb {
        r,
        g,
        b,
        icc_profile: None,
    })
}
/// `amount` of `a` over `b`.
fn mix(a: ThemeColor, b: ThemeColor, amount: f32) -> ThemeColor {
    let channel = |x: u8, y: u8| {
        (f32::from(x) * amount + f32::from(y) * (1.0 - amount))
            .round()
            .clamp(0.0, 255.0) as u8
    };
    ThemeColor(channel(a.0, b.0), channel(a.1, b.1), channel(a.2, b.2))
}
fn callout_color(kind: CalloutKind, theme: &DocumentTheme) -> ThemeColor {
    match kind {
        CalloutKind::Note => theme.colors.accent,
        CalloutKind::Tip => ThemeColor(0x1f, 0x8a, 0x4c),
        CalloutKind::Warning => ThemeColor(0xb4, 0x6b, 0x00),
        CalloutKind::Danger => ThemeColor(0xc0, 0x39, 0x2b),
    }
}

// ---- Fonts and text measurement ----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Face {
    Regular,
    Bold,
    Italic,
    BoldItalic,
    Mono,
}

struct LoadedFont {
    parsed: ParsedFont,
    id: FontId,
}

struct Fonts {
    regular: LoadedFont,
    bold: LoadedFont,
    italic: Option<LoadedFont>,
    bold_italic: Option<LoadedFont>,
    mono: LoadedFont,
}

fn load_font(pdf: &mut PdfDocument, bytes: &[u8], name: &str) -> DocumentResult<LoadedFont> {
    let parsed = ParsedFont::from_bytes(bytes, 0, &mut vec![])
        .ok_or_else(|| failure(format!("Cannot load the {name} font.")))?;
    let id = pdf.add_font(&parsed);
    Ok(LoadedFont { parsed, id })
}

impl Fonts {
    fn new(pdf: &mut PdfDocument, theme: &DocumentTheme) -> DocumentResult<Self> {
        let mono = load_font(
            pdf,
            include_bytes!("../assets/fonts/DejaVuSansMono.ttf"),
            "code",
        )?;
        Ok(match &theme.fonts {
            Some(fonts) => Self {
                regular: load_font(pdf, &fonts.regular, "regular")?,
                bold: load_font(pdf, &fonts.bold, "bold")?,
                italic: fonts
                    .italic
                    .as_deref()
                    .map(|bytes| load_font(pdf, bytes, "italic"))
                    .transpose()?,
                bold_italic: fonts
                    .bold_italic
                    .as_deref()
                    .map(|bytes| load_font(pdf, bytes, "bold italic"))
                    .transpose()?,
                mono,
            },
            None => Self {
                regular: load_font(
                    pdf,
                    include_bytes!("../assets/fonts/DejaVuSans.ttf"),
                    "document",
                )?,
                bold: load_font(
                    pdf,
                    include_bytes!("../assets/fonts/DejaVuSans-Bold.ttf"),
                    "bold",
                )?,
                italic: None,
                bold_italic: None,
                mono,
            },
        })
    }

    /// The font for a face and whether it has to be slanted.
    fn get(&self, face: Face) -> (&LoadedFont, bool) {
        match face {
            Face::Regular => (&self.regular, false),
            Face::Bold => (&self.bold, false),
            Face::Italic => self
                .italic
                .as_ref()
                .map_or((&self.regular, true), |font| (font, false)),
            Face::BoldItalic => self
                .bold_italic
                .as_ref()
                .map_or((&self.bold, true), |font| (font, false)),
            Face::Mono => (&self.mono, false),
        }
    }

    fn width(&self, text: &str, face: Face, size: f32) -> f32 {
        let font = &self.get(face).0.parsed;
        let em = f32::from(font.units_per_em.max(1));
        text.chars()
            .map(|c| {
                font.lookup_glyph_index(c as u32)
                    .and_then(|id| font.get_glyph_width(id))
                    .unwrap_or(1000) as f32
                    / em
                    * size
            })
            .sum()
    }
}

#[derive(Debug, Clone)]
struct Span {
    text: String,
    face: Face,
    size: f32,
    color: ThemeColor,
    link: Option<String>,
    strike: bool,
    code: bool,
}

struct Frag {
    span: usize,
    text: String,
    width: f32,
}

struct TextLine {
    frags: Vec<Frag>,
    width: f32,
}

#[derive(Clone, Copy)]
struct TextStyle {
    size: f32,
    color: ThemeColor,
    bold: bool,
}

fn spans_from_runs(runs: &[InlineRun], style: TextStyle, accent: ThemeColor) -> Vec<Span> {
    runs.iter()
        .map(|run| {
            let bold = style.bold || run.bold;
            let face = if run.code {
                Face::Mono
            } else {
                match (bold, run.italic) {
                    (true, true) => Face::BoldItalic,
                    (true, false) => Face::Bold,
                    (false, true) => Face::Italic,
                    (false, false) => Face::Regular,
                }
            };
            let link = run.link.clone().filter(|url| !url.is_empty());
            Span {
                text: run.text.clone(),
                face,
                size: if run.code {
                    style.size * 0.9
                } else {
                    style.size
                },
                color: if link.is_some() { accent } else { style.color },
                link,
                strike: run.strike,
                code: run.code,
            }
        })
        .collect()
}

/// Greedy line breaking over styled spans; `\n` forces a break and long words split by character.
fn wrap(fonts: &Fonts, spans: &[Span], width: f32) -> Vec<TextLine> {
    let mut lines = Vec::new();
    let mut line = TextLine {
        frags: Vec::new(),
        width: 0.0,
    };
    let push = |line: &mut TextLine, span: usize, text: &str, w: f32| {
        match line.frags.last_mut() {
            Some(last) if last.span == span => {
                last.text.push_str(text);
                last.width += w;
            }
            _ => line.frags.push(Frag {
                span,
                text: text.to_string(),
                width: w,
            }),
        }
        line.width += w;
    };
    let finish = |line: &mut TextLine, lines: &mut Vec<TextLine>| {
        while let Some(last) = line.frags.last_mut() {
            let trimmed = last.text.trim_end().len();
            if trimmed == last.text.len() {
                break;
            }
            let removed = last.text.len() - trimmed;
            let ratio = if last.text.is_empty() {
                0.0
            } else {
                removed as f32 / last.text.len() as f32
            };
            line.width -= last.width * ratio;
            last.width -= last.width * ratio;
            last.text.truncate(trimmed);
            if last.text.is_empty() {
                line.frags.pop();
            }
        }
        lines.push(std::mem::replace(
            line,
            TextLine {
                frags: Vec::new(),
                width: 0.0,
            },
        ));
    };
    for (index, span) in spans.iter().enumerate() {
        for (part_index, part) in span.text.split('\n').enumerate() {
            if part_index > 0 {
                finish(&mut line, &mut lines);
            }
            let mut rest = part;
            while !rest.is_empty() {
                let split = rest.find(char::is_whitespace).map_or(rest.len(), |at| {
                    if at == 0 {
                        rest.chars().next().map_or(1, char::len_utf8)
                    } else {
                        at
                    }
                });
                let token = &rest[..split];
                rest = &rest[split..];
                let is_space = token.chars().all(char::is_whitespace);
                if is_space {
                    // Code keeps its indentation and spacing; prose collapses whitespace.
                    let after_space = line
                        .frags
                        .last()
                        .is_none_or(|frag| frag.text.ends_with(' '));
                    if span.face == Face::Mono || !after_space {
                        push(
                            &mut line,
                            index,
                            " ",
                            fonts.width(" ", span.face, span.size),
                        );
                    }
                    continue;
                }
                let w = fonts.width(token, span.face, span.size);
                if line.width + w > width && !line.frags.is_empty() {
                    finish(&mut line, &mut lines);
                }
                if w <= width {
                    push(&mut line, index, token, w);
                    continue;
                }
                for c in token.chars() {
                    let mut buffer = [0; 4];
                    let piece = c.encode_utf8(&mut buffer);
                    let cw = fonts.width(piece, span.face, span.size);
                    if line.width + cw > width && !line.frags.is_empty() {
                        finish(&mut line, &mut lines);
                    }
                    push(&mut line, index, piece, cw);
                }
            }
        }
    }
    if !line.frags.is_empty() || lines.is_empty() {
        finish(&mut line, &mut lines);
    }
    lines
}

fn truncate_to(fonts: &Fonts, text: &str, face: Face, size: f32, width: f32) -> String {
    if fonts.width(text, face, size) <= width {
        return text.to_string();
    }
    let mut out = String::new();
    for c in text.chars() {
        let mut next = out.clone();
        next.push(c);
        if fonts.width(&format!("{next}…"), face, size) > width {
            break;
        }
        out = next;
    }
    format!("{}…", out.trim_end())
}

// ---- Images ----

struct DecodedImage {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

/// Images decode once per export and are shared by both layout passes.
#[derive(Default)]
struct ImageCache {
    images: HashMap<String, DecodedImage>,
    decoded_bytes: u64,
}

impl ImageCache {
    fn load(
        &mut self,
        store: &DocumentationStore,
        document: &str,
        target: &str,
    ) -> DocumentResult<&DecodedImage> {
        let id = target
            .strip_prefix("assets/")
            .and_then(|s| s.strip_suffix(".png"))
            .ok_or_else(|| {
                document_invalid("Images must refer to this document's assets (assets/<id>.png).")
            })?;
        if !self.images.contains_key(id) {
            let decoded = crate::documentation_store::decode_document_image(
                &store.read_asset(document, id)?,
            )?;
            self.decoded_bytes += u64::from(decoded.width()) * u64::from(decoded.height()) * 4;
            if self.decoded_bytes > IMAGE_BUDGET {
                return Err(document_invalid(
                    "PDF images exceed the 256 MiB decoded image budget. Use fewer or smaller images.",
                ));
            }
            let rgba = decoded.into_rgba8();
            self.images.insert(
                id.to_string(),
                DecodedImage {
                    width: rgba.width(),
                    height: rgba.height(),
                    pixels: rgba.into_raw(),
                },
            );
        }
        self.images
            .get(id)
            .ok_or_else(|| failure("Image cache miss."))
    }
}

fn raw_image(image: &DecodedImage, top: u32, rows: u32) -> RawImage {
    let stride = image.width as usize * 4;
    let start = top as usize * stride;
    let end = (start + rows as usize * stride).min(image.pixels.len());
    RawImage {
        pixels: RawImageData::U8(image.pixels[start..end].to_vec()),
        width: image.width as usize,
        height: rows as usize,
        data_format: RawImageFormat::RGBA8,
        tag: vec![],
    }
}

// ---- Layout ----

struct OpenBox {
    start_index: usize,
    start_y: f32,
    x: f32,
    width: f32,
    fill: Option<ThemeColor>,
    bar: Option<(ThemeColor, f32)>,
}

struct PageOut {
    ops: Vec<Op>,
    cover: bool,
}

struct Layout<'a> {
    pdf: PdfDocument,
    fonts: Fonts,
    theme: &'a DocumentTheme,
    labels: &'a DocumentLabels,
    store: &'a DocumentationStore,
    document_id: &'a str,
    images: &'a mut ImageCache,
    flag: &'a AtomicBool,
    pages: Vec<PageOut>,
    ops: Vec<Op>,
    y: f32,
    boxes: Vec<OpenBox>,
    measuring: u32,
    no_breaks: u32,
    /// Page of each heading laid out so far.
    headings: Vec<usize>,
    /// Page of each heading from the previous pass, for the table of contents.
    toc_pages: &'a [usize],
    current_cover: bool,
}

impl<'a> Layout<'a> {
    fn page_number(&self) -> usize {
        self.pages.len() + 1
    }

    fn at_top(&self) -> bool {
        self.y >= TOP - 0.5
    }

    fn emit(&mut self, ops: impl IntoIterator<Item = Op>) {
        if self.measuring == 0 {
            self.ops.extend(ops);
        }
    }

    fn rect(&mut self, x: f32, y: f32, width: f32, height: f32, fill: ThemeColor) {
        self.emit([
            Op::SetFillColor { col: color(fill) },
            Op::DrawRectangle {
                rectangle: Rect {
                    x: Pt(x),
                    y: Pt(y),
                    width: Pt(width),
                    height: Pt(height),
                    mode: Some(PaintMode::Fill),
                    winding_order: None,
                },
            },
        ]);
    }

    fn line(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, stroke: ThemeColor, thickness: f32) {
        self.emit([
            Op::SetOutlineColor { col: color(stroke) },
            Op::SetOutlineThickness { pt: Pt(thickness) },
            Op::DrawLine {
                line: Line {
                    points: vec![
                        LinePoint {
                            p: Point {
                                x: Pt(x1),
                                y: Pt(y1),
                            },
                            bezier: false,
                        },
                        LinePoint {
                            p: Point {
                                x: Pt(x2),
                                y: Pt(y2),
                            },
                            bezier: false,
                        },
                    ],
                    is_closed: false,
                },
            },
        ]);
    }

    fn text(&mut self, text: &str, x: f32, baseline: f32, face: Face, size: f32, fill: ThemeColor) {
        if self.measuring > 0 || text.is_empty() {
            return;
        }
        let (font, slant) = self.fonts.get(face);
        let id = font.id.clone();
        let position = if slant {
            Op::SetTextMatrix {
                matrix: TextMatrix::Raw([1.0, 0.0, SLANT, 1.0, x, baseline]),
            }
        } else {
            Op::SetTextCursor {
                pos: Point {
                    x: Pt(x),
                    y: Pt(baseline),
                },
            }
        };
        self.ops.extend([
            Op::StartTextSection,
            Op::SetFillColor { col: color(fill) },
            Op::SetFont {
                font: PdfFontHandle::External(id),
                size: Pt(size),
            },
            position,
            Op::ShowText {
                items: vec![TextItem::Text(text.into())],
            },
            Op::EndTextSection,
        ]);
    }

    fn link(&mut self, x: f32, y: f32, width: f32, height: f32, actions: Actions) {
        self.emit([Op::LinkAnnotation {
            link: LinkAnnotation::new(
                Rect::from_xywh(Pt(x), Pt(y), Pt(width), Pt(height)),
                actions,
                Some(BorderArray::Solid([0.0, 0.0, 0.0])),
                None,
                None,
            ),
        }]);
    }

    /// Closes the open boxes on this page, behind their content.
    fn close_box_segments(&mut self, bottom: f32) {
        for index in (0..self.boxes.len()).rev() {
            let open = &self.boxes[index];
            let height = open.start_y - bottom;
            if height <= 0.0 || self.measuring > 0 {
                continue;
            }
            let mut ops = Vec::new();
            if let Some(fill) = open.fill {
                ops.extend([
                    Op::SetFillColor { col: color(fill) },
                    Op::DrawRectangle {
                        rectangle: Rect {
                            x: Pt(open.x),
                            y: Pt(bottom),
                            width: Pt(open.width),
                            height: Pt(height),
                            mode: Some(PaintMode::Fill),
                            winding_order: None,
                        },
                    },
                ]);
            }
            if let Some((bar, width)) = open.bar {
                ops.extend([
                    Op::SetFillColor { col: color(bar) },
                    Op::DrawRectangle {
                        rectangle: Rect {
                            x: Pt(open.x),
                            y: Pt(bottom),
                            width: Pt(width),
                            height: Pt(height),
                            mode: Some(PaintMode::Fill),
                            winding_order: None,
                        },
                    },
                ]);
            }
            let at = open.start_index.min(self.ops.len());
            self.ops.splice(at..at, ops);
        }
    }

    fn new_page(&mut self) -> DocumentResult<()> {
        cancelled(self.flag)?;
        if self.measuring > 0 {
            return Ok(());
        }
        if self.pages.len() + 1 >= MAX_PAGES {
            return Err(document_invalid("The PDF exceeds 200 pages."));
        }
        self.close_box_segments(BOTTOM - 4.0);
        let ops = std::mem::take(&mut self.ops);
        self.pages.push(PageOut {
            ops,
            cover: std::mem::take(&mut self.current_cover),
        });
        self.y = TOP;
        for open in &mut self.boxes {
            open.start_index = 0;
            open.start_y = TOP + 4.0;
        }
        Ok(())
    }

    /// Starts a new page unless `height` fits below the cursor.
    fn room(&mut self, height: f32) -> DocumentResult<()> {
        if self.measuring > 0 || self.no_breaks > 0 {
            return Ok(());
        }
        if self.y - height < BOTTOM && !self.at_top() {
            self.new_page()?;
        }
        Ok(())
    }

    fn open_box(
        &mut self,
        x: f32,
        width: f32,
        fill: Option<ThemeColor>,
        bar: Option<(ThemeColor, f32)>,
    ) {
        self.boxes.push(OpenBox {
            start_index: self.ops.len(),
            start_y: self.y,
            x,
            width,
            fill,
            bar,
        });
    }

    fn close_box(&mut self) {
        if self.boxes.is_empty() {
            return;
        }
        // Only the innermost box ends here; draw it without touching the outer ones.
        let outer = self.boxes.len() - 1;
        let inner = self.boxes.split_off(outer);
        let saved = std::mem::replace(&mut self.boxes, inner);
        let y = self.y;
        self.close_box_segments(y);
        self.boxes = saved;
    }

    /// Height of `blocks` laid out at `width`, without drawing.
    fn measure(&mut self, blocks: &[DocumentBlock], width: f32) -> DocumentResult<f32> {
        let y = self.y;
        let headings = self.headings.len();
        self.measuring += 1;
        self.y = 0.0;
        let result = self.blocks(blocks, 0.0, width, false);
        let height = -self.y;
        self.measuring -= 1;
        self.y = y;
        self.headings.truncate(headings);
        result.map(|_| height)
    }

    fn draw_lines(
        &mut self,
        lines: &[TextLine],
        spans: &[Span],
        x: f32,
        width: f32,
        align: BlockAlign,
        line_height: f32,
    ) -> DocumentResult<()> {
        for line in lines {
            cancelled(self.flag)?;
            self.room(line_height)?;
            let size = line
                .frags
                .iter()
                .map(|f| spans[f.span].size)
                .fold(0.0_f32, f32::max)
                .max(1.0);
            let baseline = self.y - line_height + (line_height - size) / 2.0 + size * 0.22;
            let mut cursor = x + match align {
                BlockAlign::Left => 0.0,
                BlockAlign::Center => (width - line.width).max(0.0) / 2.0,
                BlockAlign::Right => (width - line.width).max(0.0),
            };
            for frag in &line.frags {
                let span = &spans[frag.span];
                if span.code {
                    let surface = self.theme.colors.surface;
                    self.rect(
                        cursor - 1.5,
                        baseline - span.size * 0.28,
                        frag.width + 3.0,
                        span.size * 1.2,
                        mix(self.theme.colors.border, surface, 0.35),
                    );
                }
                self.text(
                    &frag.text, cursor, baseline, span.face, span.size, span.color,
                );
                if span.strike {
                    self.line(
                        cursor,
                        baseline + span.size * 0.3,
                        cursor + frag.width,
                        baseline + span.size * 0.3,
                        span.color,
                        0.6,
                    );
                }
                if let Some(url) = &span.link {
                    let url = url.clone();
                    self.line(
                        cursor,
                        baseline - 1.4,
                        cursor + frag.width,
                        baseline - 1.4,
                        span.color,
                        0.5,
                    );
                    self.link(
                        cursor,
                        baseline - 3.0,
                        frag.width,
                        span.size + 3.0,
                        Actions::Uri(url),
                    );
                }
                cursor += frag.width;
            }
            self.y -= line_height;
        }
        Ok(())
    }

    fn paragraph(
        &mut self,
        runs: &[InlineRun],
        x: f32,
        width: f32,
        align: BlockAlign,
        style: TextStyle,
        space_after: f32,
    ) -> DocumentResult<()> {
        let spans = spans_from_runs(runs, style, self.theme.colors.accent);
        let lines = wrap(&self.fonts, &spans, width);
        self.draw_lines(&lines, &spans, x, width, align, style.size * LINE)?;
        self.y -= space_after;
        Ok(())
    }

    fn body_style(&self) -> TextStyle {
        TextStyle {
            size: BODY_SIZE,
            color: self.theme.colors.text,
            bold: false,
        }
    }

    fn heading(
        &mut self,
        level: u8,
        number: Option<&str>,
        runs: &[InlineRun],
        x: f32,
        width: f32,
        align: BlockAlign,
    ) -> DocumentResult<()> {
        let (size, before, after) = match level {
            1 => (19.0, 18.0, 10.0),
            2 => (14.5, 14.0, 6.0),
            3 => (12.0, 11.0, 4.0),
            _ => (10.5, 9.0, 3.0),
        };
        if !self.at_top() {
            self.y -= before;
        }
        // Keep the heading with the start of its section.
        self.room(size * 1.35 + BODY_SIZE * LINE * 3.0)?;
        let mut all = Vec::new();
        if let Some(number) = number {
            all.push(InlineRun {
                text: format!("{number}  "),
                ..Default::default()
            });
        }
        all.extend_from_slice(runs);
        let color = if level >= 4 {
            self.theme.colors.text
        } else {
            self.theme.colors.heading
        };
        let title = alcy_app::plain_text(&all).replace("  ", " ");
        if self.measuring == 0 {
            let page = self.page_number();
            self.headings.push(page);
            self.pdf.add_bookmark(&title, page);
        }
        let spans = spans_from_runs(
            &all,
            TextStyle {
                size,
                color,
                bold: true,
            },
            self.theme.colors.accent,
        );
        let lines = wrap(&self.fonts, &spans, width);
        self.draw_lines(&lines, &spans, x, width, align, size * 1.3)?;
        if level == 1 {
            self.y -= 3.0;
            let border = self.theme.colors.border;
            self.line(x, self.y, x + width, self.y, border, 0.7);
        }
        self.y -= after;
        Ok(())
    }

    fn list(
        &mut self,
        ordered: bool,
        start: u64,
        items: &[Vec<DocumentBlock>],
        x: f32,
        width: f32,
        depth: usize,
    ) -> DocumentResult<()> {
        let markers = (0..items.len())
            .map(|i| {
                if ordered {
                    format!("{}.", start.saturating_add(i as u64))
                } else {
                    ["•", "◦", "▪"][depth % 3].to_string()
                }
            })
            .collect::<Vec<_>>();
        let column = markers
            .iter()
            .map(|m| self.fonts.width(m, Face::Regular, BODY_SIZE))
            .fold(0.0_f32, f32::max)
            + 8.0;
        for (item, marker) in items.iter().zip(&markers) {
            let line_height = BODY_SIZE * LINE;
            self.room(line_height)?;
            let baseline =
                self.y - line_height + (line_height - BODY_SIZE) / 2.0 + BODY_SIZE * 0.22;
            let marker_width = self.fonts.width(marker, Face::Regular, BODY_SIZE);
            let color = if ordered {
                self.theme.colors.text
            } else {
                self.theme.colors.accent
            };
            self.text(
                marker,
                x + column - 8.0 - marker_width,
                baseline,
                Face::Regular,
                BODY_SIZE,
                color,
            );
            for block in item {
                match block {
                    DocumentBlock::List {
                        ordered,
                        start,
                        items,
                    } => self.list(
                        *ordered,
                        *start,
                        items,
                        x + column,
                        width - column,
                        depth + 1,
                    )?,
                    other => self.block(other, x + column, width - column, true)?,
                }
            }
            self.y -= 1.0;
        }
        // Nested lists flow into the next item of their parent.
        if depth == 0 {
            self.y -= 5.0;
        }
        Ok(())
    }

    fn code(&mut self, lang: Option<&str>, text: &str, x: f32, width: f32) -> DocumentResult<()> {
        let size = 8.6;
        let line_height = size * 1.45;
        let padding = 8.0;
        let spans = vec![Span {
            text: text.replace('\t', "    "),
            face: Face::Mono,
            size,
            color: self.theme.colors.text,
            link: None,
            strike: false,
            code: false,
        }];
        let lines = wrap(&self.fonts, &spans, width - padding * 2.0);
        let mut rest = &lines[..];
        let mut first = true;
        self.room(line_height * 2.0 + padding * 2.0)?;
        while !rest.is_empty() {
            cancelled(self.flag)?;
            let available = if self.measuring > 0 || self.no_breaks > 0 {
                f32::MAX
            } else {
                self.y - BOTTOM - padding * 2.0
            };
            let mut count = ((available / line_height).floor() as usize).min(rest.len());
            if count == 0 {
                self.new_page()?;
                count = (((self.y - BOTTOM - padding * 2.0) / line_height).floor() as usize)
                    .clamp(1, rest.len());
            }
            let (chunk, remaining) = rest.split_at(count);
            let height = chunk.len() as f32 * line_height + padding * 2.0;
            let (surface, border) = (self.theme.colors.surface, self.theme.colors.border);
            self.rect(x, self.y - height, width, height, border);
            self.rect(
                x + 0.6,
                self.y - height + 0.6,
                width - 1.2,
                height - 1.2,
                surface,
            );
            if first && let Some(lang) = lang {
                let label_width = self.fonts.width(lang, Face::Regular, 7.0);
                let muted = self.theme.colors.muted;
                self.text(
                    lang,
                    x + width - padding - label_width,
                    self.y - 9.0,
                    Face::Regular,
                    7.0,
                    muted,
                );
            }
            self.y -= padding;
            self.draw_lines(
                chunk,
                &spans,
                x + padding,
                width - padding * 2.0,
                BlockAlign::Left,
                line_height,
            )?;
            self.y -= padding;
            rest = remaining;
            first = false;
            if !rest.is_empty() {
                self.new_page()?;
            }
        }
        self.y -= 10.0;
        Ok(())
    }

    fn caption(
        &mut self,
        label: &str,
        number: Option<u32>,
        caption: &str,
        x: f32,
        width: f32,
        align: BlockAlign,
    ) -> DocumentResult<()> {
        let mut runs = Vec::new();
        if let Some(number) = number {
            runs.push(InlineRun {
                text: format!("{label} {number}: "),
                bold: true,
                ..Default::default()
            });
        }
        runs.push(InlineRun {
            text: caption.to_string(),
            ..Default::default()
        });
        let style = TextStyle {
            size: 8.8,
            color: self.theme.colors.muted,
            bold: false,
        };
        self.paragraph(&runs, x, width, align, style, 0.0)
    }

    #[allow(clippy::too_many_arguments)]
    fn table(
        &mut self,
        align: &[BlockAlign],
        header: &[Vec<InlineRun>],
        rows: &[Vec<Vec<InlineRun>>],
        caption: Option<&str>,
        number: Option<u32>,
        x: f32,
        width: f32,
    ) -> DocumentResult<()> {
        let columns = align
            .len()
            .max(header.len())
            .max(rows.iter().map(Vec::len).max().unwrap_or(0));
        if columns == 0 {
            return Ok(());
        }
        let size: f32 = 9.0;
        let padding: f32 = 5.0;
        let line_height = size * 1.4;
        let (accent, text_color, heading_color) = (
            self.theme.colors.accent,
            self.theme.colors.text,
            self.theme.colors.heading,
        );
        let cell_text = |cell: Option<&Vec<InlineRun>>| {
            cell.map(|c| alcy_app::plain_text(c)).unwrap_or_default()
        };
        // Natural and minimum widths from content, then fill the text column.
        let mut natural = vec![padding * 2.0 + 12.0; columns];
        let mut minimum = vec![padding * 2.0 + 12.0; columns];
        for (row_index, row) in std::iter::once(header)
            .chain(rows.iter().map(Vec::as_slice))
            .enumerate()
        {
            let face = if row_index == 0 {
                Face::Bold
            } else {
                Face::Regular
            };
            for column in 0..columns {
                let text = cell_text(row.get(column));
                natural[column] =
                    natural[column].max(self.fonts.width(&text, face, size) + padding * 2.0);
                let word = text
                    .split_whitespace()
                    .map(|w| self.fonts.width(w, face, size))
                    .fold(0.0_f32, f32::max);
                minimum[column] =
                    minimum[column].max((word + padding * 2.0).min(width / columns as f32 * 1.6));
            }
        }
        let total_natural: f32 = natural.iter().sum();
        let widths = if total_natural <= width {
            natural
                .iter()
                .map(|w| w * width / total_natural)
                .collect::<Vec<_>>()
        } else {
            let total_minimum: f32 = minimum.iter().sum();
            if total_minimum >= width {
                minimum.iter().map(|w| w * width / total_minimum).collect()
            } else {
                let extra: f32 = natural
                    .iter()
                    .zip(&minimum)
                    .map(|(n, m)| n - m)
                    .sum::<f32>()
                    .max(1.0);
                natural
                    .iter()
                    .zip(&minimum)
                    .map(|(n, m)| m + (n - m) / extra * (width - total_minimum))
                    .collect()
            }
        };
        if let Some(caption) = caption {
            self.room(line_height * 4.0)?;
            self.caption(
                self.labels.table,
                number,
                caption,
                x,
                width,
                BlockAlign::Left,
            )?;
            self.y -= 3.0;
        }
        let layout_row =
            |this: &Self, row: &[Vec<InlineRun>], bold: bool| -> Vec<(Vec<Span>, Vec<TextLine>)> {
                (0..columns)
                    .map(|column| {
                        let runs = row.get(column).cloned().unwrap_or_default();
                        let style = TextStyle {
                            size,
                            color: if bold { heading_color } else { text_color },
                            bold,
                        };
                        let spans = spans_from_runs(&runs, style, accent);
                        let lines = wrap(
                            &this.fonts,
                            &spans,
                            (widths[column] - padding * 2.0).max(4.0),
                        );
                        (spans, lines)
                    })
                    .collect()
            };
        let header_cells = layout_row(self, header, true);
        let header_height = header_cells.iter().map(|(_, l)| l.len()).max().unwrap_or(1) as f32
            * line_height
            + padding * 2.0;
        self.room(header_height + line_height * 2.0 + padding * 2.0)?;
        let border = self.theme.colors.border;
        let header_fill = mix(accent, WHITE, 0.1);
        let zebra = self.theme.colors.surface;
        self.draw_row(
            &header_cells,
            &widths,
            align,
            x,
            header_fill,
            line_height,
            padding,
        )?;
        let mut page = self.page_number();
        for (index, row) in rows.iter().enumerate() {
            cancelled(self.flag)?;
            let cells = layout_row(self, row, false);
            let height = cells.iter().map(|(_, l)| l.len()).max().unwrap_or(1) as f32 * line_height
                + padding * 2.0;
            self.room(height.min(TOP - BOTTOM - header_height))?;
            if self.page_number() != page {
                page = self.page_number();
                self.draw_row(
                    &header_cells,
                    &widths,
                    align,
                    x,
                    header_fill,
                    line_height,
                    padding,
                )?;
            }
            let fill = if index % 2 == 1 { zebra } else { WHITE };
            self.draw_row(&cells, &widths, align, x, fill, line_height, padding)?;
        }
        self.line(
            x,
            self.y,
            x + width,
            self.y,
            mix(border, self.theme.colors.muted, 0.5),
            0.8,
        );
        self.y -= 12.0;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_row(
        &mut self,
        cells: &[(Vec<Span>, Vec<TextLine>)],
        widths: &[f32],
        align: &[BlockAlign],
        x: f32,
        fill: ThemeColor,
        line_height: f32,
        padding: f32,
    ) -> DocumentResult<()> {
        let rows = cells.iter().map(|(_, l)| l.len()).max().unwrap_or(1);
        let height = rows as f32 * line_height + padding * 2.0;
        let total: f32 = widths.iter().sum();
        let top = self.y;
        if fill != WHITE {
            self.rect(x, top - height, total, height, fill);
        }
        let mut cursor = x;
        for (column, (spans, lines)) in cells.iter().enumerate() {
            self.y = top - padding;
            self.no_breaks += 1;
            let result = self.draw_lines(
                lines,
                spans,
                cursor + padding,
                widths[column] - padding * 2.0,
                align.get(column).copied().unwrap_or_default(),
                line_height,
            );
            self.no_breaks -= 1;
            result?;
            cursor += widths[column];
        }
        self.y = top - height;
        let border = self.theme.colors.border;
        self.line(x, self.y, x + total, self.y, border, 0.5);
        Ok(())
    }

    /// `placement` is the width fraction and alignment the document asks for.
    fn image(
        &mut self,
        target: &str,
        caption: &str,
        number: Option<u32>,
        (fraction, align): (Option<f32>, BlockAlign),
        x: f32,
        width: f32,
    ) -> DocumentResult<()> {
        let (store, document) = (self.store, self.document_id);
        let (pixel_width, pixel_height) = {
            let image = self.images.load(store, document, target)?;
            (image.width.max(1), image.height.max(1))
        };
        // Screenshots come at screen density: 96 dpi shows them at their on-screen size.
        let natural = pixel_width as f32 * 0.75;
        let mut draw_width = fraction
            .map_or(natural.min(width), |f| width * f)
            .min(width);
        let mut draw_height = pixel_height as f32 * draw_width / pixel_width as f32;
        let caption_height = if caption.is_empty() { 0.0 } else { 24.0 };
        let page_height = TOP - BOTTOM - caption_height - 8.0;
        let mut sliced = false;
        if draw_height > page_height {
            let fit = page_height / draw_height;
            if draw_width * fit >= width * 0.45 {
                draw_width *= fit;
                draw_height = page_height;
            } else {
                sliced = true;
            }
        }
        let left = x + match align {
            BlockAlign::Left => 0.0,
            BlockAlign::Center => (width - draw_width) / 2.0,
            BlockAlign::Right => width - draw_width,
        };
        let scale = draw_width / pixel_width as f32;
        if sliced {
            let slice_rows = ((page_height / scale).floor() as u32).max(1);
            for top in (0..pixel_height).step_by(slice_rows as usize) {
                cancelled(self.flag)?;
                let rows = slice_rows.min(pixel_height - top);
                let height = rows as f32 * scale;
                self.room(height + 6.0)?;
                self.place_image(target, top, rows, left, height, scale)?;
                self.y -= height + 4.0;
            }
        } else {
            self.room(draw_height + caption_height + 6.0)?;
            self.place_image(target, 0, pixel_height, left, draw_height, scale)?;
            self.y -= draw_height + 6.0;
        }
        if !caption.is_empty() {
            let caption_align = if align == BlockAlign::Left {
                BlockAlign::Left
            } else {
                align
            };
            self.caption(self.labels.figure, number, caption, x, width, caption_align)?;
        }
        self.y -= 10.0;
        Ok(())
    }

    fn place_image(
        &mut self,
        target: &str,
        top: u32,
        rows: u32,
        x: f32,
        height: f32,
        scale: f32,
    ) -> DocumentResult<()> {
        if self.measuring > 0 {
            return Ok(());
        }
        let raw = {
            let image = self.images.load(self.store, self.document_id, target)?;
            raw_image(image, top, rows)
        };
        let id = self.pdf.add_image(&raw);
        let border = self.theme.colors.border;
        let width = raw.width as f32 * scale;
        self.ops.push(Op::UseXobject {
            id,
            transform: XObjectTransform {
                translate_x: Some(Pt(x)),
                translate_y: Some(Pt(self.y - height)),
                scale_x: Some(scale),
                scale_y: Some(scale),
                dpi: Some(72.0),
                ..Default::default()
            },
        });
        // A hairline frame keeps white screenshots from bleeding into the page.
        let (bottom, right, up) = (self.y - height, x + width, self.y);
        for (x1, y1, x2, y2) in [
            (x, bottom, right, bottom),
            (x, up, right, up),
            (x, bottom, x, up),
            (right, bottom, right, up),
        ] {
            self.line(x1, y1, x2, y2, border, 0.4);
        }
        Ok(())
    }

    fn callout(
        &mut self,
        kind: CalloutKind,
        title: Option<&str>,
        blocks: &[DocumentBlock],
        x: f32,
        width: f32,
    ) -> DocumentResult<()> {
        let tone = callout_color(kind, self.theme);
        let label = title
            .unwrap_or(match kind {
                CalloutKind::Note => self.labels.note,
                CalloutKind::Tip => self.labels.tip,
                CalloutKind::Warning => self.labels.warning,
                CalloutKind::Danger => self.labels.danger,
            })
            .to_string();
        self.room(BODY_SIZE * LINE * 3.0 + 18.0)?;
        self.open_box(x, width, Some(mix(tone, WHITE, 0.08)), Some((tone, 3.0)));
        self.y -= 9.0;
        let inner_x = x + 15.0;
        let inner_width = width - 27.0;
        self.paragraph(
            &[InlineRun {
                text: label,
                bold: true,
                ..Default::default()
            }],
            inner_x,
            inner_width,
            BlockAlign::Left,
            TextStyle {
                size: 10.0,
                color: tone,
                bold: true,
            },
            1.0,
        )?;
        self.blocks(blocks, inner_x, inner_width, true)?;
        self.y -= 5.0;
        self.close_box();
        self.y -= 12.0;
        Ok(())
    }

    fn columns(
        &mut self,
        columns: &[Vec<DocumentBlock>],
        x: f32,
        width: f32,
    ) -> DocumentResult<()> {
        let gap = 18.0;
        let count = columns.len() as f32;
        let column_width = (width - gap * (count - 1.0)) / count;
        let mut height = 0.0_f32;
        for column in columns {
            height = height.max(self.measure(column, column_width)?);
        }
        if height > TOP - BOTTOM {
            // Too tall for one page: stack the columns.
            for column in columns {
                self.blocks(column, x, width, false)?;
            }
            return Ok(());
        }
        self.room(height)?;
        let top = self.y;
        let mut lowest = top;
        self.no_breaks += 1;
        let mut result = Ok(());
        for (index, column) in columns.iter().enumerate() {
            self.y = top;
            result = self.blocks(
                column,
                x + index as f32 * (column_width + gap),
                column_width,
                false,
            );
            if result.is_err() {
                break;
            }
            lowest = lowest.min(self.y);
        }
        self.no_breaks -= 1;
        result?;
        self.y = lowest.min(top - height);
        Ok(())
    }

    fn quote(&mut self, blocks: &[DocumentBlock], x: f32, width: f32) -> DocumentResult<()> {
        let bar = mix(self.theme.colors.muted, WHITE, 0.45);
        self.open_box(x, width, None, Some((bar, 2.5)));
        self.y -= 2.0;
        self.blocks(blocks, x + 14.0, width - 14.0, true)?;
        self.close_box();
        self.y -= 8.0;
        Ok(())
    }

    fn toc(&mut self, x: f32, width: f32, entries: &[(u8, String)]) -> DocumentResult<()> {
        let size = 19.0;
        self.room(size * 2.0 + 40.0)?;
        let heading = self.theme.colors.heading;
        let label = self.labels.contents.to_string();
        let spans = vec![Span {
            text: label,
            face: Face::Bold,
            size,
            color: heading,
            link: None,
            strike: false,
            code: false,
        }];
        let lines = wrap(&self.fonts, &spans, width);
        self.draw_lines(&lines, &spans, x, width, BlockAlign::Left, size * 1.3)?;
        self.y -= 3.0;
        let border = self.theme.colors.border;
        self.line(x, self.y, x + width, self.y, border, 0.7);
        self.y -= 12.0;
        let (muted, text_color) = (self.theme.colors.muted, self.theme.colors.text);
        for (index, (level, title)) in entries.iter().enumerate() {
            cancelled(self.flag)?;
            if *level > 3 {
                continue;
            }
            let (face, size, before) = if *level == 1 {
                (Face::Bold, 10.5, 5.0)
            } else {
                (Face::Regular, 10.0, 0.0)
            };
            let line_height = size * 1.55;
            self.y -= before;
            self.room(line_height)?;
            let indent = f32::from(level - 1) * 16.0;
            let page = self.toc_pages.get(index).copied();
            let page_text = page.map(|p| p.to_string()).unwrap_or_default();
            let page_width = self.fonts.width(&page_text, face, size);
            let available = width - indent - page_width - 24.0;
            let text = truncate_to(&self.fonts, title, face, size, available);
            let text_width = self.fonts.width(&text, face, size);
            let baseline = self.y - line_height + (line_height - size) / 2.0 + size * 0.22;
            self.text(
                &text,
                x + indent,
                baseline,
                face,
                size,
                if *level == 1 { heading } else { text_color },
            );
            let dot = self.fonts.width(". ", Face::Regular, size);
            let start = x + indent + text_width + 6.0;
            let end = x + width - page_width - 6.0;
            if dot > 0.0 && end > start {
                let count = ((end - start) / dot).floor() as usize;
                let dots = ". ".repeat(count);
                self.text(
                    &dots,
                    end - count as f32 * dot,
                    baseline,
                    Face::Regular,
                    size,
                    mix(muted, WHITE, 0.6),
                );
            }
            self.text(
                &page_text,
                x + width - page_width,
                baseline,
                face,
                size,
                text_color,
            );
            if let Some(page) = page {
                self.link(
                    x + indent,
                    self.y - line_height,
                    width - indent,
                    line_height,
                    Actions::Goto(Destination::Xyz {
                        page,
                        left: None,
                        top: Some(PAGE_H),
                        zoom: None,
                    }),
                );
            }
            self.y -= line_height;
        }
        self.y -= 14.0;
        Ok(())
    }

    fn block(
        &mut self,
        block: &DocumentBlock,
        x: f32,
        width: f32,
        compact: bool,
    ) -> DocumentResult<()> {
        cancelled(self.flag)?;
        let space = if compact { 4.0 } else { 8.0 };
        match block {
            DocumentBlock::Heading {
                level,
                number,
                runs,
                align,
            } => self.heading(*level, number.as_deref(), runs, x, width, *align),
            DocumentBlock::Paragraph { runs, align } => {
                self.paragraph(runs, x, width, *align, self.body_style(), space)
            }
            DocumentBlock::List {
                ordered,
                start,
                items,
            } => self.list(*ordered, *start, items, x, width, 0),
            DocumentBlock::Quote(blocks) => self.quote(blocks, x, width),
            DocumentBlock::Code { lang, text } => self.code(lang.as_deref(), text, x, width),
            DocumentBlock::Table {
                align,
                header,
                rows,
                caption,
                number,
            } => self.table(align, header, rows, caption.as_deref(), *number, x, width),
            DocumentBlock::Image {
                target,
                caption,
                number,
                width: fraction,
                align,
            } => self.image(target, caption, *number, (*fraction, *align), x, width),
            DocumentBlock::Rule => {
                self.y -= 6.0;
                self.room(8.0)?;
                let border = self.theme.colors.border;
                self.line(x, self.y, x + width, self.y, border, 0.8);
                self.y -= 12.0;
                Ok(())
            }
            DocumentBlock::Callout {
                kind,
                title,
                blocks,
            } => self.callout(*kind, title.as_deref(), blocks, x, width),
            DocumentBlock::Columns(columns) => self.columns(columns, x, width),
            DocumentBlock::PageBreak => {
                if self.measuring == 0 && self.no_breaks == 0 && !self.at_top() {
                    self.new_page()?;
                }
                Ok(())
            }
            DocumentBlock::Toc => Ok(()),
        }
    }

    fn blocks(
        &mut self,
        blocks: &[DocumentBlock],
        x: f32,
        width: f32,
        compact: bool,
    ) -> DocumentResult<()> {
        for block in blocks {
            self.block(block, x, width, compact)?;
        }
        Ok(())
    }
}

// ---- Document parts ----

fn meta_rows(model: &DocumentModel, labels: &DocumentLabels) -> Vec<(&'static str, String)> {
    let meta = &model.meta;
    [
        (labels.author, &meta.author),
        (labels.version, &meta.version),
        (labels.date, &meta.date),
        (labels.status, &meta.status),
    ]
    .into_iter()
    .filter_map(|(label, value)| value.clone().map(|value| (label, value)))
    .collect()
}

fn logo_size(image: &DecodedImage, max_width: f32, max_height: f32) -> (f32, f32) {
    let scale =
        (max_width / image.width.max(1) as f32).min(max_height / image.height.max(1) as f32);
    (image.width as f32 * scale, image.height as f32 * scale)
}

fn place_logo(
    layout: &mut Layout<'_>,
    logo: &DecodedImage,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
) {
    if layout.measuring > 0 {
        return;
    }
    let id = layout.pdf.add_image(&raw_image(logo, 0, logo.height));
    let scale = width / logo.width.max(1) as f32;
    layout.ops.push(Op::UseXobject {
        id,
        transform: XObjectTransform {
            translate_x: Some(Pt(x)),
            translate_y: Some(Pt(y)),
            scale_x: Some(scale),
            scale_y: Some(height / logo.height.max(1) as f32),
            dpi: Some(72.0),
            ..Default::default()
        },
    });
}

fn cover(
    layout: &mut Layout<'_>,
    title: &str,
    model: &DocumentModel,
    logo: Option<&DecodedImage>,
) -> DocumentResult<()> {
    let colors = layout.theme.colors.clone();
    layout.current_cover = true;
    layout.rect(0.0, PAGE_H - 10.0, PAGE_W, 10.0, colors.accent);
    if let Some(logo) = logo {
        let (w, h) = logo_size(logo, 170.0, 52.0);
        place_logo(layout, logo, MARGIN_X, PAGE_H - 64.0 - h, w, h);
    }
    layout.y = PAGE_H * 0.62;
    let title_spans = vec![Span {
        text: title.to_string(),
        face: Face::Bold,
        size: 30.0,
        color: colors.heading,
        link: None,
        strike: false,
        code: false,
    }];
    let lines = wrap(&layout.fonts, &title_spans, CONTENT_W);
    layout.draw_lines(
        &lines,
        &title_spans,
        MARGIN_X,
        CONTENT_W,
        BlockAlign::Left,
        37.0,
    )?;
    if let Some(subtitle) = &model.meta.subtitle {
        layout.y -= 6.0;
        let spans = vec![Span {
            text: subtitle.clone(),
            face: Face::Regular,
            size: 15.0,
            color: colors.muted,
            link: None,
            strike: false,
            code: false,
        }];
        let lines = wrap(&layout.fonts, &spans, CONTENT_W);
        layout.draw_lines(&lines, &spans, MARGIN_X, CONTENT_W, BlockAlign::Left, 21.0)?;
    }
    layout.y -= 16.0;
    layout.rect(MARGIN_X, layout.y, 64.0, 3.0, colors.accent);
    let rows = meta_rows(model, layout.labels);
    let mut y = 96.0 + rows.len() as f32 * 22.0;
    for (label, value) in rows {
        layout.text(
            &label.to_uppercase(),
            MARGIN_X,
            y,
            Face::Bold,
            7.8,
            colors.muted,
        );
        let value = truncate_to(
            &layout.fonts,
            &value,
            Face::Regular,
            10.5,
            CONTENT_W - 110.0,
        );
        layout.text(
            &value,
            MARGIN_X + 110.0,
            y,
            Face::Regular,
            10.5,
            colors.text,
        );
        layout.line(
            MARGIN_X,
            y - 8.0,
            MARGIN_X + CONTENT_W,
            y - 8.0,
            colors.border,
            0.5,
        );
        y -= 22.0;
    }
    if let Some(header) = &layout.theme.header_text {
        let header = header.clone();
        layout.text(&header, MARGIN_X, 52.0, Face::Bold, 8.5, colors.muted);
    }
    layout.new_page()
}

fn title_block(layout: &mut Layout<'_>, title: &str, model: &DocumentModel) -> DocumentResult<()> {
    let colors = layout.theme.colors.clone();
    let spans = vec![Span {
        text: title.to_string(),
        face: Face::Bold,
        size: 24.0,
        color: colors.heading,
        link: None,
        strike: false,
        code: false,
    }];
    let lines = wrap(&layout.fonts, &spans, CONTENT_W);
    layout.draw_lines(&lines, &spans, MARGIN_X, CONTENT_W, BlockAlign::Left, 30.0)?;
    if let Some(subtitle) = &model.meta.subtitle {
        let spans = vec![Span {
            text: subtitle.clone(),
            face: Face::Regular,
            size: 13.0,
            color: colors.muted,
            link: None,
            strike: false,
            code: false,
        }];
        let lines = wrap(&layout.fonts, &spans, CONTENT_W);
        layout.draw_lines(&lines, &spans, MARGIN_X, CONTENT_W, BlockAlign::Left, 18.0)?;
    }
    let rows = meta_rows(model, layout.labels);
    if !rows.is_empty() {
        layout.y -= 4.0;
        let text = rows
            .iter()
            .map(|(label, value)| format!("{label}: {value}"))
            .collect::<Vec<_>>()
            .join("   ·   ");
        let spans = vec![Span {
            text,
            face: Face::Regular,
            size: 8.8,
            color: colors.muted,
            link: None,
            strike: false,
            code: false,
        }];
        let lines = wrap(&layout.fonts, &spans, CONTENT_W);
        layout.draw_lines(&lines, &spans, MARGIN_X, CONTENT_W, BlockAlign::Left, 13.0)?;
    }
    layout.y -= 10.0;
    layout.rect(MARGIN_X, layout.y, 48.0, 2.5, colors.accent);
    layout.y -= 22.0;
    Ok(())
}

fn header_and_footer(layout: &mut Layout<'_>, title: &str, logo: Option<&DecodedImage>) {
    let total = layout.pages.len();
    let colors = layout.theme.colors.clone();
    let header_text = layout.theme.header_text.clone();
    let footer_text = layout.theme.footer_text.clone();
    let pages = std::mem::take(&mut layout.pages);
    let mut out = Vec::with_capacity(pages.len());
    for (index, page) in pages.into_iter().enumerate() {
        if page.cover {
            out.push(page);
            continue;
        }
        layout.ops = page.ops;
        let header_y = PAGE_H - 44.0;
        let mut left = MARGIN_X;
        if let Some(logo) = logo {
            let (w, h) = logo_size(logo, 60.0, 13.0);
            place_logo(layout, logo, left, header_y - 2.0, w, h);
            left += w + 8.0;
        }
        let right_width = header_text
            .as_deref()
            .map_or(0.0, |text| layout.fonts.width(text, Face::Bold, 7.8));
        let title = truncate_to(
            &layout.fonts,
            title,
            Face::Regular,
            8.0,
            MARGIN_X + CONTENT_W - left - right_width - 16.0,
        );
        layout.text(&title, left, header_y, Face::Regular, 8.0, colors.muted);
        if let Some(text) = &header_text {
            layout.text(
                text,
                MARGIN_X + CONTENT_W - right_width,
                header_y,
                Face::Bold,
                7.8,
                colors.accent,
            );
        }
        layout.line(
            MARGIN_X,
            header_y - 7.0,
            MARGIN_X + CONTENT_W,
            header_y - 7.0,
            colors.border,
            0.5,
        );
        let footer_y = 36.0;
        layout.line(
            MARGIN_X,
            footer_y + 12.0,
            MARGIN_X + CONTENT_W,
            footer_y + 12.0,
            colors.border,
            0.5,
        );
        let number = format!(
            "{} {} {} {}",
            layout.labels.page,
            index + 1,
            layout.labels.of,
            total
        );
        let number_width = layout.fonts.width(&number, Face::Regular, 8.0);
        layout.text(
            &number,
            MARGIN_X + CONTENT_W - number_width,
            footer_y,
            Face::Regular,
            8.0,
            colors.muted,
        );
        if let Some(text) = &footer_text {
            let text = truncate_to(
                &layout.fonts,
                text,
                Face::Regular,
                8.0,
                CONTENT_W - number_width - 20.0,
            );
            layout.text(&text, MARGIN_X, footer_y, Face::Regular, 8.0, colors.muted);
        }
        out.push(PageOut {
            ops: std::mem::take(&mut layout.ops),
            cover: false,
        });
    }
    layout.pages = out;
}

struct Pass<'a> {
    store: &'a DocumentationStore,
    doc: &'a DocumentationRecord,
    model: &'a DocumentModel,
    options: &'a DocumentExportOptions,
    flag: &'a AtomicBool,
}

fn render(
    pass: &Pass<'_>,
    images: &mut ImageCache,
    logo: Option<&DecodedImage>,
    toc_pages: &[usize],
) -> DocumentResult<(PdfDocument, Vec<usize>)> {
    let theme = pass.options.theme.as_ref();
    let mut pdf = PdfDocument::new(&pass.doc.title);
    pdf.metadata.info.author = pass.model.meta.author.clone().unwrap_or_default();
    pdf.metadata.info.subject = pass.model.meta.subtitle.clone().unwrap_or_default();
    pdf.metadata.info.creator = "Alcy".into();
    let fonts = Fonts::new(&mut pdf, theme)?;
    let mut layout = Layout {
        pdf,
        fonts,
        theme,
        labels: &pass.options.labels,
        store: pass.store,
        document_id: &pass.doc.id,
        images,
        flag: pass.flag,
        pages: Vec::new(),
        ops: Vec::new(),
        y: TOP,
        boxes: Vec::new(),
        measuring: 0,
        no_breaks: 0,
        headings: Vec::new(),
        toc_pages,
        current_cover: false,
    };
    let entries = document_outline(pass.model)
        .into_iter()
        .map(|entry| {
            let title = match &entry.number {
                Some(number) => format!("{number} {}", entry.text),
                None => entry.text,
            };
            (entry.level, title)
        })
        .collect::<Vec<_>>();
    let placed_toc = pass
        .model
        .blocks
        .iter()
        .any(|block| matches!(block, DocumentBlock::Toc));
    if pass.model.meta.cover {
        cover(&mut layout, &pass.doc.title, pass.model, logo)?;
    } else {
        title_block(&mut layout, &pass.doc.title, pass.model)?;
    }
    if pass.model.meta.toc && !placed_toc && !entries.is_empty() {
        layout.toc(MARGIN_X, CONTENT_W, &entries)?;
        layout.new_page()?;
    }
    for block in &pass.model.blocks {
        if matches!(block, DocumentBlock::Toc) {
            layout.toc(MARGIN_X, CONTENT_W, &entries)?;
        } else {
            layout.block(block, MARGIN_X, CONTENT_W, false)?;
        }
    }
    if !layout.ops.is_empty() || layout.pages.is_empty() {
        layout.new_page()?;
    }
    header_and_footer(&mut layout, &pass.doc.title, logo);
    let heading_pages = std::mem::take(&mut layout.headings);
    let pages = std::mem::take(&mut layout.pages)
        .into_iter()
        .map(|page| PdfPage::new(Mm(PAGE_W * 25.4 / 72.0), Mm(PAGE_H * 25.4 / 72.0), page.ops))
        .collect();
    let mut pdf = layout.pdf;
    pdf.pages = pages;
    Ok((pdf, heading_pages))
}

pub fn export_document_pdf(
    store: &DocumentationStore,
    doc: &DocumentationRecord,
    path: &Path,
    options: &DocumentExportOptions,
    flag: &AtomicBool,
) -> DocumentResult<()> {
    if !path
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("pdf"))
    {
        return Err(document_invalid("Choose a .pdf file."));
    }
    cancelled(flag)?;
    let model = parse_document(&doc.markdown);
    let logo = match &options.theme.logo_png {
        Some(bytes) => {
            let decoded = crate::documentation_store::decode_document_image(bytes)?.into_rgba8();
            Some(DecodedImage {
                width: decoded.width(),
                height: decoded.height(),
                pixels: decoded.into_raw(),
            })
        }
        None => None,
    };
    let pass = Pass {
        store,
        doc,
        model: &model,
        options,
        flag,
    };
    let mut images = ImageCache::default();
    let wants_toc = model.meta.toc
        || model
            .blocks
            .iter()
            .any(|block| matches!(block, DocumentBlock::Toc));
    let (mut pdf, pages) = render(&pass, &mut images, logo.as_ref(), &[])?;
    if wants_toc {
        // The first pass finds each heading's page; the second prints them in the contents.
        pdf = render(&pass, &mut images, logo.as_ref(), &pages)?.0;
    }
    cancelled(flag)?;
    let bytes = pdf.save(&PdfSaveOptions::default(), &mut vec![]);
    cancelled(flag)?;
    crate::documentation_store::atomic(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_app::{
        DocumentEdit, DocumentThemes, DocumentationRepository, create_document, update_document,
    };

    fn options(language: &str) -> DocumentExportOptions {
        DocumentExportOptions {
            theme: DocumentThemes::default().resolve(None),
            labels: DocumentLabels::for_language(language),
        }
    }

    fn fixture(
        name: &str,
        markdown: String,
    ) -> (std::path::PathBuf, DocumentationStore, DocumentationRecord) {
        let root =
            std::env::temp_dir().join(format!("alcy-pdf-test-{}-{name}", std::process::id()));
        let store = DocumentationStore::new(root.clone());
        let _ = store.remove("pdf");
        create_document(&store, "pdf".into(), "Investigação".into(), 1).unwrap();
        let doc = update_document(
            &store,
            "pdf",
            1,
            DocumentEdit {
                markdown: Some(markdown),
                ..Default::default()
            },
            2,
        )
        .unwrap();
        (root, store, doc)
    }

    #[test]
    fn exports_selectable_unicode_and_supports_cancellation() {
        let (root, store, doc) = fixture("basic", "# Ação e execução\n\n```json\n{\"ação\":true}\n```\n\n| Campo | Valor |\n|---|---|\n| Nome | João |\n".repeat(35));
        let path = root.join("document.pdf");
        export_document_pdf(
            &store,
            &doc,
            &path,
            &options("pt-BR"),
            &AtomicBool::new(false),
        )
        .unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
        assert!(matches!(
            export_document_pdf(
                &store,
                &doc,
                &root.join("cancel.pdf"),
                &options("en"),
                &AtomicBool::new(true)
            ),
            Err(DocumentationError::Cancelled)
        ));
        assert!(!root.join("cancel.pdf").exists());
    }

    #[test]
    fn exports_every_dialect_element_with_cover_and_contents() {
        let section = "## Endpoint\n\nCall **`GET /users`** with _care_, ~~not~~ [docs](https://example.com).\n\n1. First\n   - nested\n2. Second\n\n> Quoted note.\n\n:::warning Limits\nKeep it **under** 10 rps.\n:::\n\n:::columns\n### Before\nOld flow.\n+++\n### After\nNew flow.\n:::\n\n| Field | Type | Description |\n|---|:-:|---|\n| id | string | A long description that wraps inside its cell across lines. |\nTable: Fields\n\n---\n\n";
        let markdown = format!(
            "---\nsubtitle: Integration guide\nauthor: Platform\nversion: 1.2\ncover: true\ntoc: true\nnumbering: true\n---\n\n# Overview\n\n:::center\nCentered text.\n:::\n\n{}\\pagebreak\n\n# Appendix\n\n```bash\n{}\n```\n",
            section.repeat(8),
            "echo line\n".repeat(120)
        );
        let (root, store, doc) = fixture("dialect", markdown);
        let path = root.join("dialect.pdf");
        let mut themed = options("en");
        let mut theme = (*themed.theme).clone();
        theme.header_text = Some("Internal".into());
        theme.footer_text = Some("Company".into());
        themed.theme = std::sync::Arc::new(theme);
        export_document_pdf(&store, &doc, &path, &themed, &AtomicBool::new(false)).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("/URI"), "web links become annotations");
        assert!(text.contains("/Outlines"), "headings become bookmarks");
    }

    #[test]
    fn rejects_images_outside_the_document_assets() {
        let (root, store, doc) = fixture("image", "![x](https://example.com/a.png)\n".into());
        let error = export_document_pdf(
            &store,
            &doc,
            &root.join("image.pdf"),
            &options("en"),
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert!(matches!(error, DocumentationError::Invalid(_)));
    }

    #[test]
    fn code_keeps_indentation_while_prose_collapses_spaces() {
        let mut pdf = PdfDocument::new("t");
        let fonts = Fonts::new(&mut pdf, &alcy_app::DocumentTheme::default_theme()).unwrap();
        let span = |text: &str, face| Span {
            text: text.into(),
            face,
            size: 9.0,
            color: WHITE,
            link: None,
            strike: false,
            code: false,
        };
        let code = wrap(&fonts, &[span("{\n  \"id\":  1\n}", Face::Mono)], 400.0);
        assert_eq!(code[1].frags[0].text, "  \"id\":  1");
        let prose = wrap(&fonts, &[span("  two   words", Face::Regular)], 400.0);
        assert_eq!(prose[0].frags[0].text, "two words");
    }

    #[test]
    fn line_breaking_keeps_styles_and_splits_long_words() {
        let mut pdf = PdfDocument::new("t");
        let fonts = Fonts::new(&mut pdf, &alcy_app::DocumentTheme::default_theme()).unwrap();
        let runs = vec![
            InlineRun {
                text: "alpha ".into(),
                ..Default::default()
            },
            InlineRun {
                text: "beta".into(),
                bold: true,
                ..Default::default()
            },
            InlineRun {
                text: format!(" {}", "x".repeat(200)),
                ..Default::default()
            },
        ];
        let spans = spans_from_runs(
            &runs,
            TextStyle {
                size: 10.0,
                color: WHITE,
                bold: false,
            },
            WHITE,
        );
        let lines = wrap(&fonts, &spans, 120.0);
        assert!(lines.len() > 2);
        assert!(lines.iter().all(|line| line.width <= 120.5));
        assert_eq!(spans[lines[0].frags[1].span].face, Face::Bold);
    }
}
