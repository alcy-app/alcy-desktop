//! The exportable Markdown subset. HTML is retained as literal text.
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

#[derive(Debug)]
pub enum DocumentBlock {
    Text { text: String, size: f32, code: bool },
    Image { target: String, caption: String },
    Table(Vec<Vec<String>>),
}
pub fn document_blocks(markdown: &str) -> Vec<DocumentBlock> {
    let mut blocks = vec![];
    let mut text = String::new();
    let mut size = 11.0;
    let mut code = false;
    let mut image: Option<String> = None;
    let mut table: Option<Vec<Vec<String>>> = None;
    let mut row = vec![];
    let mut cell = String::new();
    let mut lists: Vec<Option<u64>> = Vec::new();
    let flush = |blocks: &mut Vec<DocumentBlock>, text: &mut String, size, code| {
        if !text.is_empty() {
            blocks.push(DocumentBlock::Text {
                text: std::mem::take(text),
                size,
                code,
            });
        }
    };
    for event in Parser::new_ext(
        markdown,
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH,
    ) {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                flush(&mut blocks, &mut text, size, code);
                size = 24.0 - (level as u8 as f32 * 2.0);
            }
            Event::Start(Tag::CodeBlock(_)) => {
                flush(&mut blocks, &mut text, size, code);
                code = true;
                size = 9.0;
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                flush(&mut blocks, &mut text, size, code);
                image = Some(dest_url.into_string());
            }
            Event::Start(Tag::List(start)) => lists.push(start),
            Event::End(TagEnd::List(_)) => {
                lists.pop();
            }
            Event::Start(Tag::Item) => {
                if let Some(Some(number)) = lists.last_mut() {
                    text.push_str(&format!("{number}. "));
                    *number = number.saturating_add(1);
                } else {
                    text.push_str("• ");
                }
            }
            Event::Start(Tag::Table(_)) => {
                flush(&mut blocks, &mut text, size, code);
                table = Some(vec![]);
            }
            Event::End(TagEnd::TableCell) => row.push(std::mem::take(&mut cell)),
            Event::End(TagEnd::TableHead | TagEnd::TableRow) => {
                if let Some(rows) = &mut table {
                    rows.push(std::mem::take(&mut row));
                }
            }
            Event::End(TagEnd::Table) => {
                if let Some(rows) = table.take() {
                    blocks.push(DocumentBlock::Table(rows));
                }
            }
            Event::End(TagEnd::Image) => {
                if let Some(target) = image.take() {
                    blocks.push(DocumentBlock::Image {
                        target,
                        caption: std::mem::take(&mut text),
                    });
                }
            }
            Event::End(
                TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::CodeBlock | TagEnd::Item,
            ) if table.is_none() => {
                flush(&mut blocks, &mut text, size, code);
                code = false;
                size = 11.0;
            }
            Event::Text(value)
            | Event::Code(value)
            | Event::Html(value)
            | Event::InlineHtml(value) => {
                if table.is_some() {
                    cell.push_str(&value);
                } else {
                    text.push_str(&value);
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                if table.is_some() {
                    cell.push(' ');
                } else {
                    text.push('\n');
                }
            }
            Event::Rule => text.push_str("────────────────────"),
            _ => {}
        }
    }
    flush(&mut blocks, &mut text, size, code);
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn procedure_numbering_and_code_are_preserved() {
        let blocks = document_blocks("3. Connect\n4. Send\n\n```http\nGET /users\n```\n");
        assert!(matches!(&blocks[0], DocumentBlock::Text { text, .. } if text == "3. Connect"));
        assert!(matches!(&blocks[1], DocumentBlock::Text { text, .. } if text == "4. Send"));
        assert!(
            matches!(&blocks[2], DocumentBlock::Text { text, code: true, .. } if text == "GET /users\n")
        );
    }
}
