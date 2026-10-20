//! Windowed inspection of JSON without constructing a response-sized value tree.

use std::fmt;
use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserializer, Serialize};

pub const FLOW_OUTPUT_PAGE_SIZE: usize = 100;
pub const FLOW_OUTPUT_PAGE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowOutputField {
    #[serde(skip)]
    pub offset: usize,
    pub key: String,
    pub pointer: String,
    pub kind: &'static str,
    pub preview: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowOutputPage {
    pub kind: String,
    pub preview: String,
    pub entries: Vec<FlowOutputField>,
    pub next_offset: Option<usize>,
    pub total: usize,
}

fn preview(value: &str) -> String {
    let mut end = value.len().min(512);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    if end < value.len() {
        format!("{}…", &value[..end])
    } else {
        value.to_string()
    }
}

struct Summary {
    kind: &'static str,
    preview: String,
}
struct SummarySeed;

impl<'de> DeserializeSeed<'de> for SummarySeed {
    type Value = Summary;
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Summary, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for SummarySeed {
    type Value = Summary;
    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON value")
    }
    fn visit_str<E: de::Error>(self, value: &str) -> Result<Summary, E> {
        Ok(Summary {
            kind: "string",
            preview: preview(value),
        })
    }
    fn visit_string<E: de::Error>(self, value: String) -> Result<Summary, E> {
        self.visit_str(&value)
    }
    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Summary, E> {
        Ok(Summary {
            kind: "boolean",
            preview: value.to_string(),
        })
    }
    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Summary, E> {
        Ok(Summary {
            kind: "number",
            preview: value.to_string(),
        })
    }
    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Summary, E> {
        Ok(Summary {
            kind: "number",
            preview: value.to_string(),
        })
    }
    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Summary, E> {
        Ok(Summary {
            kind: "number",
            preview: value.to_string(),
        })
    }
    fn visit_unit<E: de::Error>(self) -> Result<Summary, E> {
        Ok(Summary {
            kind: "null",
            preview: "null".into(),
        })
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Summary, A::Error> {
        let mut count = 0;
        while seq.next_element::<IgnoredAny>()?.is_some() {
            count += 1;
        }
        Ok(Summary {
            kind: "array",
            preview: count.to_string(),
        })
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Summary, A::Error> {
        let mut count = 0;
        while map.next_key::<IgnoredAny>()?.is_some() {
            map.next_value::<IgnoredAny>()?;
            count += 1;
        }
        Ok(Summary {
            kind: "object",
            preview: count.to_string(),
        })
    }
}

struct PageSeed<'a> {
    remaining: &'a [String],
    pointer: &'a str,
    offset: usize,
    query: &'a str,
    page: &'a mut FlowOutputPage,
    value_offset: Option<usize>,
}

impl PageSeed<'_> {
    fn field(&mut self, key: String, summary: Summary, index: usize) {
        if self.page.next_offset.is_some()
            || index < self.offset
            || (!self.query.is_empty() && !key.to_lowercase().contains(self.query))
        {
            return;
        }
        let mut pointer = format!(
            "{}/{}",
            self.pointer,
            key.replace('~', "~0").replace('/', "~1")
        );
        if pointer.len() > 4096 {
            pointer.clear();
        }
        let key = preview(&key);
        let budget: usize = self
            .page
            .entries
            .iter()
            .map(|entry| entry.key.len() + entry.pointer.len() + entry.preview.len() + 128)
            .sum();
        if self.page.entries.len() >= FLOW_OUTPUT_PAGE_SIZE
            || budget + key.len() + pointer.len() + summary.preview.len() + 128
                > FLOW_OUTPUT_PAGE_BYTES
        {
            self.page.next_offset.get_or_insert(index);
            return;
        }
        self.page.entries.push(FlowOutputField {
            offset: index,
            key: preview(&key),
            pointer,
            kind: summary.kind,
            preview: summary.preview,
        });
    }
}

impl<'de> DeserializeSeed<'de> for PageSeed<'_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for PageSeed<'_> {
    type Value = ();
    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON value")
    }
    fn visit_str<E: de::Error>(self, value: &str) -> Result<(), E> {
        if self.remaining.is_empty() {
            self.page.kind = "string".into();
            if let Some(offset) = self.value_offset {
                let mut start = offset.min(value.len());
                while !value.is_char_boundary(start) {
                    start += 1;
                }
                let mut end = (start + FLOW_OUTPUT_PAGE_BYTES).min(value.len());
                while !value.is_char_boundary(end) {
                    end -= 1;
                }
                self.page.preview = value[start..end].to_string();
                self.page.total = value.len();
                self.page.next_offset = (end < value.len()).then_some(end);
            } else {
                self.page.preview = preview(value);
            }
        }
        Ok(())
    }
    fn visit_string<E: de::Error>(self, value: String) -> Result<(), E> {
        self.visit_str(&value)
    }
    fn visit_bool<E: de::Error>(self, value: bool) -> Result<(), E> {
        self.scalar("boolean", value.to_string());
        Ok(())
    }
    fn visit_i64<E: de::Error>(self, value: i64) -> Result<(), E> {
        self.scalar("number", value.to_string());
        Ok(())
    }
    fn visit_u64<E: de::Error>(self, value: u64) -> Result<(), E> {
        self.scalar("number", value.to_string());
        Ok(())
    }
    fn visit_f64<E: de::Error>(self, value: f64) -> Result<(), E> {
        self.scalar("number", value.to_string());
        Ok(())
    }
    fn visit_unit<E: de::Error>(self) -> Result<(), E> {
        self.scalar("null", "null".into());
        Ok(())
    }
    fn visit_seq<A: SeqAccess<'de>>(mut self, mut seq: A) -> Result<(), A::Error> {
        if let Some((first, rest)) = self.remaining.split_first() {
            let target = first.parse::<usize>().ok();
            let mut index = 0;
            loop {
                if target == Some(index) {
                    if seq
                        .next_element_seed(PageSeed {
                            remaining: rest,
                            pointer: self.pointer,
                            offset: self.offset,
                            query: self.query,
                            page: self.page,
                            value_offset: self.value_offset,
                        })?
                        .is_none()
                    {
                        break;
                    }
                } else if seq.next_element::<IgnoredAny>()?.is_none() {
                    break;
                }
                index += 1;
            }
        } else {
            self.page.kind = "array".into();
            loop {
                if self.page.total < self.offset || self.page.next_offset.is_some() {
                    if seq.next_element::<IgnoredAny>()?.is_none() {
                        break;
                    }
                } else {
                    let Some(summary) = seq.next_element_seed(SummarySeed)? else {
                        break;
                    };
                    self.field(self.page.total.to_string(), summary, self.page.total);
                }
                self.page.total += 1;
            }
        }
        Ok(())
    }
    fn visit_map<A: MapAccess<'de>>(mut self, mut map: A) -> Result<(), A::Error> {
        if let Some((first, rest)) = self.remaining.split_first() {
            while let Some(key) = map.next_key::<String>()? {
                if &key == first {
                    map.next_value_seed(PageSeed {
                        remaining: rest,
                        pointer: self.pointer,
                        offset: self.offset,
                        query: self.query,
                        page: self.page,
                        value_offset: self.value_offset,
                    })?;
                } else {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        } else {
            self.page.kind = "object".into();
            loop {
                if self.page.total < self.offset || self.page.next_offset.is_some() {
                    if map.next_key::<IgnoredAny>()?.is_none() {
                        break;
                    }
                    map.next_value::<IgnoredAny>()?;
                } else {
                    let Some(key) = map.next_key::<String>()? else {
                        break;
                    };
                    let summary = map.next_value_seed(SummarySeed)?;
                    self.field(key, summary, self.page.total);
                }
                self.page.total += 1;
            }
        }
        Ok(())
    }
}

impl PageSeed<'_> {
    fn scalar(self, kind: &str, value: String) {
        if self.remaining.is_empty() {
            self.page.kind = kind.into();
            self.page.preview = value;
        }
    }
}

struct CancellableReader<'a, R> {
    reader: R,
    cancelled: &'a AtomicBool,
}
impl<R: Read> Read for CancellableReader<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(io::Error::other("cancelled"));
        }
        self.reader.read(buf)
    }
}

/// A streaming visitor retains at most one scalar plus a bounded page, including for huge arrays.
pub fn inspect_flow_output<R: Read>(
    reader: R,
    pointer: &str,
    offset: usize,
    query: &str,
    cancelled: &AtomicBool,
) -> Result<FlowOutputPage, String> {
    inspect_output(reader, pointer, offset, query, cancelled, None)
}

pub fn read_flow_output_value<R: Read>(
    reader: R,
    pointer: &str,
    offset: usize,
    cancelled: &AtomicBool,
) -> Result<FlowOutputPage, String> {
    let page = inspect_output(reader, pointer, 0, "", cancelled, Some(offset))?;
    if matches!(page.kind.as_str(), "object" | "array") {
        return Err("notScalar".into());
    }
    Ok(page)
}

fn inspect_output<R: Read>(
    reader: R,
    pointer: &str,
    offset: usize,
    query: &str,
    cancelled: &AtomicBool,
    value_offset: Option<usize>,
) -> Result<FlowOutputPage, String> {
    if pointer.len() > 4096
        || (!pointer.is_empty() && !pointer.starts_with('/'))
        || query.len() > 256
    {
        return Err("invalidQuery".into());
    }
    let tokens: Vec<String> = pointer
        .strip_prefix('/')
        .map(|value| {
            value
                .split('/')
                .map(|part| part.replace("~1", "/").replace("~0", "~"))
                .collect()
        })
        .unwrap_or_default();
    if tokens.len() > 128 {
        return Err("depthLimit".into());
    }
    let mut page = FlowOutputPage::default();
    let reader = CancellableReader { reader, cancelled };
    let mut deserializer = serde_json::Deserializer::from_reader(reader);
    PageSeed {
        remaining: &tokens,
        pointer,
        offset,
        query: &query.to_lowercase(),
        page: &mut page,
        value_offset,
    }
    .deserialize(&mut deserializer)
    .map_err(|_| {
        if cancelled.load(Ordering::Relaxed) {
            "cancelled"
        } else {
            "invalidJson"
        }
        .to_string()
    })?;
    deserializer.end().map_err(|_| "invalidJson".to_string())?;
    if page.kind.is_empty() {
        return Err("missingPath".into());
    }
    // Escaped control characters can take six wire bytes per input byte.
    while value_offset.is_none()
        && serde_json::to_vec(&page).map_err(|_| "invalidJson")?.len() > 48 * 1024
    {
        let Some(entry) = page.entries.pop() else {
            break;
        };
        page.next_offset = Some(entry.offset);
    }
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_large_arrays_and_navigates_escaped_keys() {
        let body = format!(
            "{{\"a/b~c\":[{}]}}",
            (0..250)
                .map(|index| index.to_string())
                .collect::<Vec<_>>()
                .join(",")
        );
        let cancelled = AtomicBool::new(false);
        let page = inspect_flow_output(body.as_bytes(), "/a~1b~0c", 100, "", &cancelled).unwrap();
        assert_eq!(page.entries.len(), 100);
        assert_eq!(page.entries[0].preview, "100");
        assert_eq!(page.next_offset, Some(200));
        assert_eq!(page.total, 250);
        assert!(serde_json::to_vec(&page).unwrap().len() < FLOW_OUTPUT_PAGE_BYTES);
    }

    #[test]
    fn bounds_unicode_previews_and_reports_invalid_or_missing_data() {
        let body = format!("{{\"text\":\"{}\",\"null\":null}}", "🦀".repeat(100_000));
        let cancelled = AtomicBool::new(false);
        let page = inspect_flow_output(body.as_bytes(), "", 0, "text", &cancelled).unwrap();
        assert!(page.entries[0].preview.len() < 520);
        assert_eq!(
            inspect_flow_output(body.as_bytes(), "/missing", 0, "", &cancelled).unwrap_err(),
            "missingPath"
        );
        assert!(inspect_flow_output(b"{broken".as_slice(), "", 0, "", &cancelled).is_err());
        cancelled.store(true, Ordering::Relaxed);
        assert_eq!(
            inspect_flow_output(body.as_bytes(), "", 0, "", &cancelled).unwrap_err(),
            "cancelled"
        );
    }
}
