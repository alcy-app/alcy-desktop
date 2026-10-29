//! Minimal Server-Sent Events reader: both providers stream their replies as
//! `event:`/`data:` records separated by a blank line.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

/// Turns arbitrary network chunks into complete events. A record split
/// across chunks (even inside a UTF-8 character) is held until it ends.
#[derive(Default)]
pub struct SseParser {
    buffer: Vec<u8>,
}

/// A single record larger than this is a broken stream, not a reply.
const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;

impl SseParser {
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<SseEvent>, String> {
        self.buffer
            .extend(chunk.iter().copied().filter(|byte| *byte != b'\r'));
        let mut events = Vec::new();
        while let Some(end) = find_record_end(&self.buffer) {
            let record: Vec<u8> = self.buffer.drain(..end + 2).collect();
            if let Some(event) = parse_record(&record[..end]) {
                events.push(event);
            }
        }
        if self.buffer.len() > MAX_RECORD_BYTES {
            return Err("event stream record is too large".into());
        }
        Ok(events)
    }

    /// The last record when the stream ends without a trailing blank line.
    pub fn finish(&mut self) -> Option<SseEvent> {
        let rest = std::mem::take(&mut self.buffer);
        parse_record(&rest)
    }
}

fn find_record_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(2).position(|pair| pair == b"\n\n")
}

fn parse_record(record: &[u8]) -> Option<SseEvent> {
    let text = String::from_utf8_lossy(record);
    let mut event = None;
    let mut data: Option<String> = None;
    for line in text.lines() {
        if line.starts_with(':') {
            continue;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "event" => event = Some(value.to_string()),
            "data" => match &mut data {
                Some(existing) => {
                    existing.push('\n');
                    existing.push_str(value);
                }
                None => data = Some(value.to_string()),
            },
            _ => {}
        }
    }
    data.map(|data| SseEvent { event, data })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_events_split_across_chunks() {
        let mut parser = SseParser::default();
        assert!(
            parser
                .feed(b"event: ping\ndata: {\"a\"")
                .unwrap()
                .is_empty()
        );
        let events = parser.feed(b":1}\n\ndata: second\n\n").unwrap();
        assert_eq!(
            events,
            vec![
                SseEvent {
                    event: Some("ping".into()),
                    data: "{\"a\":1}".into()
                },
                SseEvent {
                    event: None,
                    data: "second".into()
                },
            ]
        );
    }

    #[test]
    fn handles_crlf_comments_multiline_data_and_split_utf8() {
        let mut parser = SseParser::default();
        let bytes = ": keep-alive\r\ndata: a\r\ndata: ç\r\n\r\n".as_bytes();
        let (first, second) = bytes.split_at(bytes.len() - 6);
        assert!(parser.feed(first).unwrap().is_empty());
        let events = parser.feed(second).unwrap();
        assert_eq!(events[0].data, "a\nç");
    }

    #[test]
    fn records_without_data_are_skipped_and_the_tail_is_kept() {
        let mut parser = SseParser::default();
        assert!(parser.feed(b"event: x\n\ndata: tail").unwrap().is_empty());
        assert_eq!(parser.finish().unwrap().data, "tail");
    }
}
