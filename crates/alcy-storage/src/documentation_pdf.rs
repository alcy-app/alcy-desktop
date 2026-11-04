//! Native PDF layout with embedded fonts, selectable text and bounded images.
use crate::DocumentationStore;
use alcy_app::{
    DocumentBlock, DocumentResult, DocumentationError, DocumentationRecord, document_blocks,
    document_invalid,
};
use printpdf::*;
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

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

struct Layout {
    pdf: PdfDocument,
    pages: Vec<PdfPage>,
    ops: Vec<Op>,
    y: f32,
    sans: ParsedFont,
    mono: ParsedFont,
    sans_id: FontId,
    mono_id: FontId,
}
impl Layout {
    fn new(title: &str) -> DocumentResult<Self> {
        let sans = ParsedFont::from_bytes(
            include_bytes!("../assets/fonts/DejaVuSans.ttf"),
            0,
            &mut vec![],
        )
        .ok_or_else(|| failure("Cannot load the document font."))?;
        let mono = ParsedFont::from_bytes(
            include_bytes!("../assets/fonts/DejaVuSansMono.ttf"),
            0,
            &mut vec![],
        )
        .ok_or_else(|| failure("Cannot load the code font."))?;
        let mut pdf = PdfDocument::new(title);
        let sans_id = pdf.add_font(&sans);
        let mono_id = pdf.add_font(&mono);
        Ok(Self {
            pdf,
            pages: vec![],
            ops: vec![],
            y: 785.0,
            sans,
            mono,
            sans_id,
            mono_id,
        })
    }
    fn page(&mut self) -> DocumentResult<()> {
        if self.pages.len() >= 200 {
            return Err(document_invalid("The PDF exceeds 200 pages."));
        }
        self.text_at(
            &format!("{}", self.pages.len() + 1),
            290.0,
            28.0,
            9.0,
            false,
        );
        self.pages.push(PdfPage::new(
            Mm(210.0),
            Mm(297.0),
            std::mem::take(&mut self.ops),
        ));
        self.y = 785.0;
        Ok(())
    }
    fn room(&mut self, height: f32) -> DocumentResult<()> {
        if self.y - height < 50.0 {
            self.page()?;
        }
        Ok(())
    }
    fn text_at(&mut self, text: &str, x: f32, y: f32, size: f32, code: bool) {
        self.ops.extend([
            Op::StartTextSection,
            Op::SetTextCursor {
                pos: Point { x: Pt(x), y: Pt(y) },
            },
            Op::SetFont {
                font: PdfFontHandle::External(if code {
                    self.mono_id.clone()
                } else {
                    self.sans_id.clone()
                }),
                size: Pt(size),
            },
            Op::ShowText {
                items: vec![TextItem::Text(text.into())],
            },
            Op::EndTextSection,
        ]);
    }
    fn wrap(&self, text: &str, width: f32, size: f32, code: bool) -> Vec<String> {
        let font = if code { &self.mono } else { &self.sans };
        let mut lines = vec![];
        for original in text.lines() {
            let mut line = String::new();
            let mut used = 0.0;
            for c in original.replace('\t', "  ").chars() {
                let advance = font
                    .lookup_glyph_index(c as u32)
                    .and_then(|id| font.get_glyph_width(id))
                    .unwrap_or(1000) as f32
                    / font.units_per_em as f32
                    * size;
                if used + advance > width && !line.is_empty() {
                    lines.push(std::mem::take(&mut line));
                    used = 0.0;
                }
                line.push(c);
                used += advance;
            }
            lines.push(line);
        }
        lines
    }
    fn paragraph(
        &mut self,
        text: &str,
        size: f32,
        code: bool,
        flag: &AtomicBool,
    ) -> DocumentResult<()> {
        if size > 11.0 {
            self.room(size * 1.5 + 40.0)?;
        }
        for line in self.wrap(text, 485.0, size, code) {
            cancelled(flag)?;
            self.room(size * 1.5)?;
            self.text_at(&line, 55.0, self.y, size, code);
            self.y -= size * 1.5;
        }
        self.y -= 9.0;
        Ok(())
    }
    fn table(&mut self, rows: &[Vec<String>], flag: &AtomicBool) -> DocumentResult<()> {
        let columns = rows.first().map_or(0, Vec::len);
        if columns == 0 {
            return Ok(());
        }
        let width = 485.0 / columns as f32;
        for row in rows {
            cancelled(flag)?;
            let cells = row
                .iter()
                .map(|text| self.wrap(text, (width - 10.0).max(10.0), 9.0, false))
                .collect::<Vec<_>>();
            let lines = cells.iter().map(Vec::len).max().unwrap_or(1);
            for line in 0..lines {
                self.room(15.0)?;
                for (column, cell) in cells.iter().enumerate() {
                    if let Some(text) = cell.get(line) {
                        self.text_at(text, 55.0 + column as f32 * width, self.y, 9.0, false);
                    }
                }
                self.y -= 15.0;
            }
            self.y -= 5.0;
        }
        self.y -= 9.0;
        Ok(())
    }
}

pub fn export_document_pdf(
    store: &DocumentationStore,
    doc: &DocumentationRecord,
    path: &Path,
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
    let mut layout = Layout::new(&doc.title)?;
    let mut decoded_image_bytes = 0_u64;
    layout.paragraph(&doc.title, 24.0, false, flag)?;
    for block in document_blocks(&doc.markdown) {
        cancelled(flag)?;
        match block {
            DocumentBlock::Text { text, size, code } => {
                layout.paragraph(&text, size, code, flag)?
            }
            DocumentBlock::Table(rows) => layout.table(&rows, flag)?,
            DocumentBlock::Image { target, caption } => {
                let id = target
                    .strip_prefix("assets/")
                    .and_then(|s| s.strip_suffix(".png"))
                    .ok_or_else(|| {
                        document_invalid("Images must refer to this document's assets.")
                    })?;
                let bytes = store.read_asset(&doc.id, id)?;
                let decoded = crate::documentation_store::decode_document_image(&bytes)?;
                decoded_image_bytes += u64::from(decoded.width()) * u64::from(decoded.height()) * 4;
                if decoded_image_bytes > 256 * 1024 * 1024 {
                    return Err(document_invalid(
                        "PDF images exceed the 256 MiB decoded image budget. Use fewer or smaller images.",
                    ));
                }
                let scale = (485.0 / decoded.width() as f32).min(1.0);
                let slice_height = ((620.0 / scale).floor() as u32).max(1);
                for top in (0..decoded.height()).step_by(slice_height as usize) {
                    cancelled(flag)?;
                    let height_px = slice_height.min(decoded.height() - top);
                    let pixels = decoded
                        .crop_imm(0, top, decoded.width(), height_px)
                        .into_rgba8();
                    let image = RawImage {
                        pixels: RawImageData::U8(pixels.into_raw()),
                        width: decoded.width() as usize,
                        height: height_px as usize,
                        data_format: RawImageFormat::RGBA8,
                        tag: vec![],
                    };
                    let height = height_px as f32 * scale;
                    layout.room(height + 24.0)?;
                    let id = layout.pdf.add_image(&image);
                    layout.ops.push(Op::UseXobject {
                        id,
                        transform: XObjectTransform {
                            translate_x: Some(Pt(55.0)),
                            translate_y: Some(Pt(layout.y - height)),
                            scale_x: Some(scale),
                            scale_y: Some(scale),
                            dpi: Some(72.0),
                            ..Default::default()
                        },
                    });
                    layout.y -= height + 15.0;
                }
                layout.paragraph(&caption, 9.0, false, flag)?;
            }
        }
    }
    layout.page()?;
    layout.pdf.pages = layout.pages;
    cancelled(flag)?;
    let bytes = layout.pdf.save(&PdfSaveOptions::default(), &mut vec![]);
    cancelled(flag)?;
    crate::documentation_store::atomic(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_app::{DocumentEdit, DocumentationRepository, create_document, update_document};
    #[test]
    fn exports_selectable_unicode_and_supports_cancellation() {
        let root = std::env::temp_dir().join(format!("alcy-pdf-test-{}", std::process::id()));
        let store = DocumentationStore::new(root.clone());
        let _ = store.remove("pdf");
        create_document(&store, "pdf".into(), "Investigação".into(), 1).unwrap();
        let doc = update_document(&store, "pdf", 1, DocumentEdit { append: Some("# Ação e execução\n\n```json\n{\"ação\":true}\n```\n\n| Campo | Valor |\n|---|---|\n| Nome | João |\n".repeat(35)), ..Default::default() }, 2).unwrap();
        let path = root.join("document.pdf");
        export_document_pdf(&store, &doc, &path, &AtomicBool::new(false)).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
        assert!(matches!(
            export_document_pdf(
                &store,
                &doc,
                &root.join("cancel.pdf"),
                &AtomicBool::new(true)
            ),
            Err(DocumentationError::Cancelled)
        ));
        assert!(!root.join("cancel.pdf").exists());
        // Keep this fixture outside the repository for visual export QA.
    }
}
