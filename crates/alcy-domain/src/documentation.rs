//! Limits and editing rules for workspace documentation.

pub const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;
// Even JSON's worst-case escaping leaves room inside the 32 KiB tool-result limit.
pub const DOCUMENT_PAGE_BYTES: usize = 4 * 1024;
pub const MAX_DOCUMENT_ASSET_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_DOCUMENT_ASSETS: usize = 32;

pub fn valid_document_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

pub fn validate_document(title: &str, markdown: &str) -> Result<(), &'static str> {
    if title.trim().is_empty() || title.len() > 240 || title.chars().any(char::is_control) {
        return Err("The title must contain 1–240 bytes without control characters.");
    }
    if markdown.len() > MAX_DOCUMENT_BYTES {
        return Err("The document exceeds 1 MiB.");
    }
    Ok(())
}

/// Exact edits prevent an incomplete read from replacing unrelated content.
pub fn edit_document(markdown: &str, before: &str, after: &str) -> Result<String, &'static str> {
    if before.is_empty() {
        return Err("Use append to add content; replaceText must not be empty.");
    }
    if markdown.matches(before).count() != 1 {
        return Err("The text must match exactly once. Read the current document and retry.");
    }
    let result = markdown.replacen(before, after, 1);
    if result.len() > MAX_DOCUMENT_BYTES {
        return Err("The document exceeds 1 MiB.");
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn edits_are_unique_and_paths_are_not_ids() {
        assert_eq!(
            edit_document("a b a", "a", "c"),
            Err("The text must match exactly once. Read the current document and retry.")
        );
        assert_eq!(edit_document("ação", "ção", "ções").unwrap(), "ações");
        for id in ["../x", "", "a/b", "a\\b", "."] {
            assert!(!valid_document_id(id));
        }
        assert!(valid_document_id("document-123"));
    }
}
