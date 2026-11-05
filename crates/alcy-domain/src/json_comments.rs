//! Comments in a JSON request body (spec 0146).
//!
//! The editor accepts `//` to the end of the line and `/* … */`, outside
//! strings; the request keeps them and execution removes them here before
//! variables are resolved and the pre-request script runs. The frontend finds
//! comments with the same rules (`apps/desktop/src/features/request-workbench/json-comments.ts`).
//!
//! - A string ends at its closing quote or at the end of the line, so a quote
//!   still being typed does not swallow the rest of the body.
//! - A `/*` without a closing `*/` is not a comment.
//! - A line left with only whitespace is removed with its line break; other
//!   lines lose the comment and the whitespace before it.
//! - When a comment was removed, a comma followed only by whitespace and `}`
//!   or `]` is removed too (commenting out the last property).
//! - A body without comments comes back untouched, even if it is not valid JSON.

use std::borrow::Cow;
use std::ops::Range;

/// The body without comments; borrowed (unchanged) when it has none.
pub fn strip_json_comments(text: &str) -> Cow<'_, str> {
    let comments = comment_ranges(text);
    if comments.is_empty() {
        return Cow::Borrowed(text);
    }
    let without_comments = remove_comments(text, &comments);
    Cow::Owned(remove_dangling_commas(&without_comments))
}

/// Byte ranges of the comments. Delimiters are ASCII, so slicing at these
/// offsets never splits a UTF-8 character.
fn comment_ranges(text: &str) -> Vec<Range<usize>> {
    let bytes = text.as_bytes();
    let mut ranges = Vec::new();
    let mut in_string = false;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            if byte == b'\\' && bytes.get(index + 1) != Some(&b'\n') {
                index += 2;
            } else {
                if byte == b'"' || byte == b'\n' {
                    in_string = false;
                }
                index += 1;
            }
            continue;
        }
        match (byte, bytes.get(index + 1)) {
            (b'"', _) => {
                in_string = true;
                index += 1;
            }
            (b'/', Some(b'/')) => {
                let mut end = text[index..]
                    .find('\n')
                    .map_or(bytes.len(), |offset| index + offset);
                if end > index && bytes[end - 1] == b'\r' {
                    end -= 1;
                }
                ranges.push(index..end);
                index = end;
            }
            (b'/', Some(b'*')) => match text[index + 2..].find("*/") {
                Some(offset) => {
                    let end = index + 2 + offset + 2;
                    ranges.push(index..end);
                    index = end;
                }
                None => index += 1,
            },
            _ => index += 1,
        }
    }
    ranges
}

/// Removes the comments line by line, keeping the line breaks inside block
/// comments so the remaining lines stay where they were.
fn remove_comments(text: &str, comments: &[Range<usize>]) -> String {
    let mut output = String::with_capacity(text.len());
    let mut next_comment = 0;
    let mut line_start = 0;
    while line_start < text.len() {
        let line_end = text[line_start..]
            .find('\n')
            .map_or(text.len(), |offset| line_start + offset + 1);
        let mut content_end = line_end;
        if text[..content_end].ends_with('\n') {
            content_end -= 1;
        }
        if text[..content_end].ends_with('\r') && content_end > line_start {
            content_end -= 1;
        }
        let terminator = &text[content_end..line_end];

        // Comments ending before this line are behind us; one may continue from the previous line.
        while next_comment < comments.len() && comments[next_comment].end <= line_start {
            next_comment += 1;
        }
        let mut kept = String::new();
        let mut touched = false;
        let mut position = line_start;
        let mut index = next_comment;
        while index < comments.len() && comments[index].start < content_end.max(line_start + 1) {
            let comment = &comments[index];
            if comment.end > line_start {
                touched = true;
                if comment.start > position {
                    kept.push_str(&text[position..comment.start]);
                    // The space before the comment goes with it, not the indentation.
                    if !kept.trim().is_empty() {
                        kept.truncate(kept.trim_end().len());
                    }
                }
                position = position.max(comment.end.min(content_end));
            }
            if comment.end > content_end {
                break;
            }
            index += 1;
        }

        if touched {
            if position < content_end {
                kept.push_str(&text[position..content_end]);
            }
            if !kept.trim().is_empty() {
                output.push_str(kept.trim_end());
                output.push_str(terminator);
            }
        } else {
            output.push_str(&text[line_start..line_end]);
        }
        line_start = line_end;
    }
    output
}

/// Drops commas followed only by whitespace and a closing `}` or `]`, outside strings.
fn remove_dangling_commas(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut output = String::with_capacity(text.len());
    let mut in_string = false;
    let mut copied = 0;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            if byte == b'\\' && bytes.get(index + 1) != Some(&b'\n') {
                index += 2;
                continue;
            }
            if byte == b'"' || byte == b'\n' {
                in_string = false;
            }
        } else if byte == b'"' {
            in_string = true;
        } else if byte == b',' {
            let next = bytes[index + 1..]
                .iter()
                .find(|next| !next.is_ascii_whitespace());
            if matches!(next, Some(b'}' | b']')) {
                output.push_str(&text[copied..index]);
                copied = index + 1;
            }
        }
        index += 1;
    }
    output.push_str(&text[copied..]);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strip(text: &str) -> String {
        strip_json_comments(text).into_owned()
    }

    #[test]
    fn returns_a_body_without_comments_untouched() {
        let body = "{\n  \"a\": 1,\n}\n";
        assert!(matches!(strip_json_comments(body), Cow::Borrowed(text) if text == body));
        let url = r#"{"url": "http://example.test/*x*/"}"#;
        assert!(matches!(strip_json_comments(url), Cow::Borrowed(_)));
    }

    #[test]
    fn removes_a_line_holding_only_a_comment() {
        assert_eq!(
            strip("{\n  \"name\": \"Ana\",\n  // \"age\": 30,\n  \"city\": \"Rio\"\n}"),
            "{\n  \"name\": \"Ana\",\n  \"city\": \"Rio\"\n}"
        );
    }

    #[test]
    fn removes_a_comment_at_the_end_of_a_line_and_the_space_before_it() {
        assert_eq!(
            strip("{\n  \"a\": 1, // first\n  \"b\": 2\n}"),
            "{\n  \"a\": 1,\n  \"b\": 2\n}"
        );
    }

    #[test]
    fn removes_the_comma_left_by_commenting_out_the_last_property() {
        assert_eq!(
            strip("{\n  \"name\": \"Ana\",\n  // \"age\": 30\n}"),
            "{\n  \"name\": \"Ana\"\n}"
        );
        assert_eq!(strip("[\n  1,\n  // 2\n]"), "[\n  1\n]");
    }

    #[test]
    fn removes_a_block_comment_across_lines() {
        assert_eq!(
            strip("{\n  \"a\": 1,\n  /* \"b\": 2,\n  \"c\": 3, */\n  \"d\": 4\n}"),
            "{\n  \"a\": 1,\n  \"d\": 4\n}"
        );
        assert_eq!(
            strip("{\"a\": 1, /* start\nmiddle\nend */ \"b\": 2}"),
            "{\"a\": 1,\n \"b\": 2}"
        );
    }

    #[test]
    fn keeps_comment_markers_inside_strings() {
        assert_eq!(
            strip("{\n  \"url\": \"http://x/*y*/\", // note\n  \"q\": \"a\\\"//b\"\n}"),
            "{\n  \"url\": \"http://x/*y*/\",\n  \"q\": \"a\\\"//b\"\n}"
        );
    }

    #[test]
    fn leaves_templates_for_variable_resolution() {
        assert_eq!(
            strip("{\n  \"id\": {{id}},\n  // \"token\": \"{{missing}}\"\n}"),
            "{\n  \"id\": {{id}}\n}"
        );
    }

    #[test]
    fn treats_an_unclosed_block_as_text() {
        assert_eq!(strip("{\"a\": 1} /* open"), "{\"a\": 1} /* open");
        assert_eq!(strip("{\"a\": 1} /* open\n// x"), "{\"a\": 1} /* open\n");
    }

    #[test]
    fn ends_an_unterminated_string_at_the_line_break() {
        assert_eq!(strip("{\"a\": \"open\n// x\n}"), "{\"a\": \"open\n}");
    }

    #[test]
    fn keeps_crlf_line_breaks() {
        assert_eq!(
            strip("{\r\n  \"a\": 1, // x\r\n  // \"b\": 2\r\n}\r\n"),
            "{\r\n  \"a\": 1\r\n}\r\n"
        );
    }

    #[test]
    fn keeps_non_ascii_text_around_comments() {
        assert_eq!(
            strip("{\"nome\": \"João ✓\" /* olá */}"),
            "{\"nome\": \"João ✓\"}"
        );
    }
}
