//! Atomic, versioned documentation and bounded assets in the workspace.
use alcy_app::{
    DocumentAsset, DocumentResult, DocumentationError, DocumentationRecord,
    DocumentationRepository, document_invalid,
};
use alcy_domain::{
    MAX_DOCUMENT_ASSET_BYTES, MAX_DOCUMENT_ASSETS, MAX_DOCUMENT_BYTES, valid_document_id,
    validate_document,
};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

pub struct DocumentationStore {
    root: PathBuf,
}
fn storage(error: impl std::fmt::Display) -> DocumentationError {
    DocumentationError::Storage(error.to_string())
}

/// Every component below the workspace is app-owned; symlinks never redirect access.
fn safe_path(path: &Path) -> DocumentResult<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(document_invalid("Documentation paths cannot be symlinks."))
        }
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(storage(e)),
    }
}
fn read_limited(path: &Path, limit: usize) -> DocumentResult<Vec<u8>> {
    safe_path(path)?;
    let file = fs::File::open(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            DocumentationError::NotFound
        } else {
            storage(e)
        }
    })?;
    let metadata = file.metadata().map_err(storage)?;
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return Err(document_invalid(
            "Documentation file must be regular and within its size limit.",
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(storage)?;
    if bytes.len() > limit {
        return Err(document_invalid("Documentation file exceeds its limit."));
    }
    Ok(bytes)
}
fn read_window(
    path: &Path,
    limit: usize,
    offset: usize,
    window: usize,
) -> DocumentResult<(Vec<u8>, Option<usize>)> {
    safe_path(path)?;
    let mut file = fs::File::open(path).map_err(storage)?;
    let metadata = file.metadata().map_err(storage)?;
    let total = usize::try_from(metadata.len()).map_err(storage)?;
    if !metadata.is_file() || total > limit || offset > total {
        return Err(document_invalid("Invalid documentation window."));
    }
    file.seek(SeekFrom::Start(offset as u64)).map_err(storage)?;
    let mut bytes = vec![0; window.min(total - offset)];
    file.read_exact(&mut bytes).map_err(storage)?;
    let more = offset + bytes.len() < total;
    Ok((bytes, more.then_some(total)))
}
pub(crate) fn decode_document_image(bytes: &[u8]) -> DocumentResult<image::DynamicImage> {
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(storage)?;
    if !matches!(
        reader.format(),
        Some(image::ImageFormat::Png | image::ImageFormat::Jpeg)
    ) {
        return Err(document_invalid("Only PNG and JPEG images are supported."));
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(12_000);
    limits.max_image_height = Some(12_000);
    limits.max_alloc = Some(96 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode().map_err(storage)?;
    if u64::from(decoded.width()) * u64::from(decoded.height()) > 24_000_000 {
        return Err(document_invalid("The image exceeds 24 megapixels."));
    }
    Ok(decoded)
}
pub(crate) fn atomic(path: &Path, bytes: &[u8]) -> DocumentResult<()> {
    safe_path(path)?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = path.with_extension(format!("writing-{}-{nonce}", std::process::id()));
    safe_path(&temp)?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(storage)?;
    let result = (|| {
        file.write_all(bytes).map_err(storage)?;
        file.sync_all().map_err(storage)?;
        drop(file);
        fs::rename(&temp, path).map_err(storage)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
impl DocumentationStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root: root.join("alcy-documents"),
        }
    }
    fn directory(&self, id: &str) -> DocumentResult<PathBuf> {
        if !valid_document_id(id) {
            return Err(document_invalid("Invalid document id."));
        }
        safe_path(&self.root)?;
        let path = self.root.join(id);
        safe_path(&path)?;
        Ok(path)
    }
    fn metadata(&self, id: &str) -> DocumentResult<DocumentationRecord> {
        let bytes = read_limited(&self.directory(id)?.join("document.json"), 128 * 1024)?;
        let doc: DocumentationRecord = serde_json::from_slice(&bytes).map_err(storage)?;
        if doc.version != 1
            || doc.id != id
            || doc.sources.len() > 100
            || doc.assets.len() > MAX_DOCUMENT_ASSETS
        {
            return Err(document_invalid(
                "Unsupported or invalid document metadata.",
            ));
        }
        Ok(doc)
    }
    pub fn read_asset(&self, id: &str, asset_id: &str) -> DocumentResult<Vec<u8>> {
        if !valid_document_id(asset_id)
            || !self.metadata(id)?.assets.iter().any(|a| a.id == asset_id)
        {
            return Err(DocumentationError::NotFound);
        }
        let directory = self.directory(id)?.join("assets");
        safe_path(&directory)?;
        read_limited(
            &directory.join(format!("{asset_id}.png")),
            MAX_DOCUMENT_ASSET_BYTES,
        )
    }
    pub fn add_image(
        &self,
        id: &str,
        caption: String,
        bytes: &[u8],
        expected: u64,
    ) -> DocumentResult<DocumentationRecord> {
        self.add_image_cancellable(
            id,
            caption,
            bytes,
            expected,
            &std::sync::atomic::AtomicBool::new(false),
        )
    }
    fn add_image_cancellable(
        &self,
        id: &str,
        caption: String,
        bytes: &[u8],
        expected: u64,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> DocumentResult<DocumentationRecord> {
        if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(DocumentationError::Cancelled);
        }
        let mut doc = self.load(id)?;
        alcy_app::check_document_revision(&doc, expected)?;
        if doc.assets.len() >= MAX_DOCUMENT_ASSETS
            || caption.len() > 500
            || caption.chars().any(char::is_control)
            || bytes.len() > MAX_DOCUMENT_ASSET_BYTES
        {
            return Err(document_invalid(
                "Image or caption exceeds the document limits.",
            ));
        }
        let decoded = decode_document_image(bytes)?;
        if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(DocumentationError::Cancelled);
        }
        let mut png = std::io::Cursor::new(Vec::new());
        decoded
            .write_to(&mut png, image::ImageFormat::Png)
            .map_err(storage)?;
        let png = png.into_inner();
        if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(DocumentationError::Cancelled);
        }
        if png.len() > MAX_DOCUMENT_ASSET_BYTES {
            return Err(document_invalid("The normalized image exceeds 8 MiB."));
        }
        let asset_id = alcy_app::content_hash(&png);
        let directory = self.directory(id)?.join("assets");
        safe_path(&directory)?;
        fs::create_dir_all(&directory).map_err(storage)?;
        if !doc.assets.iter().any(|a| a.id == asset_id) {
            doc.assets.push(DocumentAsset {
                id: asset_id.clone(),
                caption: caption.clone(),
            });
        }
        doc.markdown.push_str(&format!(
            "\n\n![{}](assets/{asset_id}.png)\n",
            caption.replace(['[', ']', '\n', '\r'], " ")
        ));
        doc.revision += 1;
        doc.updated_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        validate_document(&doc.title, &doc.markdown).map_err(document_invalid)?;
        atomic(&directory.join(format!("{asset_id}.png")), &png)?;
        self.write(&doc)?;
        Ok(doc)
    }
    pub fn import_image(
        &self,
        id: &str,
        caption: String,
        path: &Path,
        expected: u64,
    ) -> DocumentResult<DocumentationRecord> {
        self.import_image_cancellable(
            id,
            caption,
            path,
            expected,
            &std::sync::atomic::AtomicBool::new(false),
        )
    }
    fn import_image_cancellable(
        &self,
        id: &str,
        caption: String,
        path: &Path,
        expected: u64,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> DocumentResult<DocumentationRecord> {
        if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(DocumentationError::Cancelled);
        }
        if !path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| matches!(s.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg"))
        {
            return Err(document_invalid("Choose a PNG or JPEG file."));
        }
        let bytes = read_limited(path, MAX_DOCUMENT_ASSET_BYTES)?;
        self.add_image_cancellable(id, caption, &bytes, expected, cancelled)
    }
    pub fn snapshot_source(
        &self,
        id: &str,
        kind: &str,
        source_id: &str,
        text: &str,
    ) -> DocumentResult<()> {
        if !valid_document_id(source_id) || !matches!(kind, "chat" | "request") {
            return Err(document_invalid("Invalid source."));
        }
        let limit = if source_id.ends_with("-image") {
            256 * 1024
        } else {
            32 * 1024
        };
        if text.len() > limit {
            return Err(document_invalid(
                "The source snapshot exceeds its page limit.",
            ));
        }
        let dir = self.directory(id)?.join("sources");
        safe_path(&dir)?;
        fs::create_dir_all(&dir).map_err(storage)?;
        atomic(
            &dir.join(format!("{kind}-{source_id}.txt")),
            text.as_bytes(),
        )
    }
    pub fn source_snapshot(&self, id: &str, kind: &str, source_id: &str) -> DocumentResult<String> {
        if !valid_document_id(source_id) || !matches!(kind, "chat" | "request") {
            return Err(document_invalid("Invalid source."));
        }
        let dir = self.directory(id)?.join("sources");
        safe_path(&dir)?;
        String::from_utf8(read_limited(
            &dir.join(format!("{kind}-{source_id}.txt")),
            if source_id.ends_with("-image") {
                256 * 1024
            } else {
                32 * 1024
            },
        )?)
        .map_err(storage)
    }
    pub fn export_markdown(&self, doc: &DocumentationRecord, path: &Path) -> DocumentResult<()> {
        self.export_markdown_cancellable(doc, path, &std::sync::atomic::AtomicBool::new(false))
    }
    fn export_markdown_cancellable(
        &self,
        doc: &DocumentationRecord,
        path: &Path,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> DocumentResult<()> {
        if !path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("md"))
        {
            return Err(document_invalid("Choose an .md file."));
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| document_invalid("Invalid output filename."))?;
        let asset_name = format!("{stem}.assets");
        let dir = path.with_file_name(&asset_name);
        safe_path(&dir)?;
        if !doc.assets.is_empty() {
            fs::create_dir_all(&dir).map_err(storage)?;
        }
        for asset in &doc.assets {
            if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(DocumentationError::Cancelled);
            }
            atomic(
                &dir.join(format!("{}.png", asset.id)),
                &self.read_asset(&doc.id, &asset.id)?,
            )?;
        }
        if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(DocumentationError::Cancelled);
        }
        let reference_directory = asset_name.bytes().fold(String::new(), |mut text, byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.') {
                text.push(byte as char);
            } else {
                text.push_str(&format!("%{byte:02X}"));
            }
            text
        });
        atomic(
            path,
            doc.markdown
                .replace("](assets/", &format!("]({reference_directory}/"))
                .as_bytes(),
        )
    }
}
impl DocumentationRepository for DocumentationStore {
    fn list(&self) -> DocumentResult<Vec<DocumentationRecord>> {
        safe_path(&self.root)?;
        if !self.root.exists() {
            return Ok(vec![]);
        }
        let mut docs = vec![];
        for entry in fs::read_dir(&self.root).map_err(storage)?.take(201) {
            let entry = entry.map_err(storage)?;
            if !entry.file_type().map_err(storage)?.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            docs.push(self.metadata(&id)?);
        }
        if docs.len() > 200 {
            return Err(document_invalid("The workspace exceeds 200 documents."));
        }
        docs.sort_by_key(|d| std::cmp::Reverse(d.updated_at_ms));
        Ok(docs)
    }
    fn load(&self, id: &str) -> DocumentResult<DocumentationRecord> {
        let mut doc = self.metadata(id)?;
        doc.markdown = String::from_utf8(read_limited(
            &self
                .directory(id)?
                .join(format!("content-{}.md", doc.revision)),
            MAX_DOCUMENT_BYTES,
        )?)
        .map_err(storage)?;
        validate_document(&doc.title, &doc.markdown).map_err(document_invalid)?;
        Ok(doc)
    }
    fn write(&self, doc: &DocumentationRecord) -> DocumentResult<()> {
        validate_document(&doc.title, &doc.markdown).map_err(document_invalid)?;
        if doc.revision == 0 || doc.revision == u64::MAX {
            return Err(document_invalid("Invalid document revision."));
        }
        let mut metadata = doc.clone();
        metadata.markdown.clear();
        let metadata_bytes = serde_json::to_vec_pretty(&metadata).map_err(storage)?;
        if metadata_bytes.len() > 128 * 1024 {
            return Err(document_invalid("Document metadata exceeds 128 KiB."));
        }
        let directory = self.directory(&doc.id)?;
        fs::create_dir_all(&directory).map_err(storage)?;
        let content = directory.join(format!("content-{}.md", doc.revision));
        atomic(&content, doc.markdown.as_bytes())?;
        atomic(&directory.join("document.json"), &metadata_bytes)?;
        // The metadata atomically points to a complete immutable content revision.
        if doc.revision > 1 {
            let _ = fs::remove_file(directory.join(format!("content-{}.md", doc.revision - 1)));
        }
        Ok(())
    }
    fn remove(&self, id: &str) -> DocumentResult<()> {
        self.metadata(id)?;
        fs::remove_dir_all(self.directory(id)?).map_err(storage)
    }
}

impl alcy_app::DocumentationWorkspace for DocumentationStore {
    fn read_document_page(
        &self,
        id: &str,
        offset: usize,
    ) -> DocumentResult<(DocumentationRecord, alcy_app::DocumentTextPage)> {
        let doc = self.metadata(id)?;
        let path = self
            .directory(id)?
            .join(format!("content-{}.md", doc.revision));
        let (mut bytes, next) = read_window(
            &path,
            MAX_DOCUMENT_BYTES,
            offset,
            alcy_domain::DOCUMENT_PAGE_BYTES,
        )?;
        let total_bytes = next.unwrap_or(offset + bytes.len());
        let length = match std::str::from_utf8(&bytes) {
            Ok(_) => bytes.len(),
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            Err(_) => {
                return Err(document_invalid(
                    "Invalid UTF-8 document cursor or content.",
                ));
            }
        };
        bytes.truncate(length);
        let text = String::from_utf8(bytes).map_err(storage)?;
        let end = offset + length;
        Ok((
            doc,
            alcy_app::DocumentTextPage {
                text,
                next_offset: (end < total_bytes).then_some(end),
                total_bytes,
            },
        ))
    }
    fn read_asset_page(
        &self,
        id: &str,
        asset_id: &str,
        offset: usize,
    ) -> DocumentResult<(Vec<u8>, Option<usize>)> {
        if !valid_document_id(asset_id)
            || !self
                .metadata(id)?
                .assets
                .iter()
                .any(|asset| asset.id == asset_id)
        {
            return Err(DocumentationError::NotFound);
        }
        let directory = self.directory(id)?.join("assets");
        safe_path(&directory)?;
        let (bytes, total) = read_window(
            &directory.join(format!("{asset_id}.png")),
            MAX_DOCUMENT_ASSET_BYTES,
            offset,
            64 * 1024,
        )?;
        let end = offset + bytes.len();
        Ok((bytes, total.filter(|total| end < *total).map(|_| end)))
    }

    fn snapshot_source(
        &self,
        id: &str,
        kind: &str,
        source_id: &str,
        text: &str,
    ) -> DocumentResult<()> {
        self.snapshot_source(id, kind, source_id, text)
    }
    fn source_snapshot(&self, id: &str, kind: &str, source_id: &str) -> DocumentResult<String> {
        self.source_snapshot(id, kind, source_id)
    }
    fn read_asset(&self, id: &str, asset_id: &str) -> DocumentResult<Vec<u8>> {
        self.read_asset(id, asset_id)
    }
    fn add_image(
        &self,
        id: &str,
        caption: String,
        bytes: &[u8],
        expected: u64,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> DocumentResult<DocumentationRecord> {
        self.add_image_cancellable(id, caption, bytes, expected, cancelled)
    }
    fn import_document_image(
        &self,
        id: &str,
        caption: String,
        path: &str,
        expected: u64,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> DocumentResult<DocumentationRecord> {
        self.import_image_cancellable(id, caption, Path::new(path), expected, cancelled)
    }
    fn export_document(
        &self,
        doc: &DocumentationRecord,
        path: &str,
        format: &str,
        options: &alcy_app::DocumentExportOptions,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> DocumentResult<()> {
        if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(DocumentationError::Cancelled);
        }
        match format {
            "md" => self.export_markdown_cancellable(doc, Path::new(path), cancelled),
            "pdf" => crate::export_document_pdf(self, doc, Path::new(path), options, cancelled),
            _ => Err(document_invalid("Choose md or pdf.")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alcy_app::{DocumentEdit, create_document, update_document};
    #[test]
    fn persists_and_rejects_stale_updates() {
        let root = std::env::temp_dir().join(format!(
            "alcy-doc-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = DocumentationStore::new(root.clone());
        assert!(store.list().unwrap().is_empty());
        let doc = create_document(&store, "one".into(), "Investigation".into(), 1).unwrap();
        update_document(
            &store,
            &doc.id,
            1,
            DocumentEdit {
                append: Some("# Ação\n".into()),
                ..Default::default()
            },
            2,
        )
        .unwrap();
        assert!(matches!(
            update_document(&store, &doc.id, 1, DocumentEdit::default(), 3),
            Err(DocumentationError::Conflict)
        ));
        assert_eq!(store.load("one").unwrap().markdown, "# Ação\n");
        store
            .export_markdown(&store.load("one").unwrap(), &root.join("out.md"))
            .unwrap();
        assert_eq!(fs::read_to_string(root.join("out.md")).unwrap(), "# Ação\n");
        store.remove("one").unwrap();
        assert!(store.list().unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    struct Sources(std::cell::Cell<bool>);
    #[test]
    fn native_windows_reconstruct_unicode_without_splitting_characters() {
        use alcy_app::DocumentationWorkspace;
        let root = std::env::temp_dir().join(format!(
            "alcy-doc-windows-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = DocumentationStore::new(root.clone());
        create_document(&store, "one".into(), "Unicode".into(), 1).unwrap();
        let text = "Ação: 🦌\n".repeat(3000);
        update_document(
            &store,
            "one",
            1,
            DocumentEdit {
                markdown: Some(text.clone()),
                ..Default::default()
            },
            2,
        )
        .unwrap();
        let mut restored = String::new();
        let mut offset = 0;
        loop {
            let (_, page) = store.read_document_page("one", offset).unwrap();
            assert_eq!(page.total_bytes, text.len());
            assert!(page.text.len() <= alcy_domain::DOCUMENT_PAGE_BYTES);
            restored.push_str(&page.text);
            match page.next_offset {
                Some(next) => offset = next,
                None => break,
            }
        }
        assert_eq!(restored, text);
        assert!(store.read_document_page("one", 2).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    impl alcy_app::DocumentationSources for Sources {
        fn list(&self) -> DocumentResult<Vec<alcy_app::DocumentSource>> {
            Ok(vec![alcy_app::DocumentSource {
                kind: "chat".into(),
                id: "chat-one".into(),
                label: "Investigation".into(),
                at_ms: None,
            }])
        }
        fn read(&self, _kind: &str, _id: &str) -> DocumentResult<String> {
            if self.0.get() {
                Ok("ação\n".repeat(10_000))
            } else {
                Err(DocumentationError::NotFound)
            }
        }
        fn redact_text(&self, text: &str) -> String {
            text.to_string()
        }
    }
    #[test]
    fn sources_require_selection_and_only_read_pages_are_retained() {
        let root = std::env::temp_dir().join(format!(
            "alcy-doc-sources-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = DocumentationStore::new(root.clone());
        create_document(&store, "one".into(), "Investigation".into(), 1).unwrap();
        let sources = Sources(std::cell::Cell::new(true));
        let call = |value: serde_json::Value| {
            let input = serde_json::from_value::<alcy_app::DocumentationInput>(value).unwrap();
            alcy_app::execute_document_operation(
                &store,
                &sources,
                &alcy_app::DocumentThemes::default(),
                input,
                None,
                &std::sync::atomic::AtomicBool::new(false),
            )
        };
        let outline =
            call(serde_json::json!({"rootPath":"unused","operation":"outline","documentId":"one"}))
                .unwrap();
        assert_eq!(outline["headings"], serde_json::json!([]));
        assert_eq!(outline["metadata"]["cover"], false);
        let themes = call(serde_json::json!({"rootPath":"unused","operation":"themes"})).unwrap();
        assert_eq!(themes["themes"][0]["id"], "default");
        let read = serde_json::json!({"rootPath":"unused","operation":"readSource","documentId":"one","sourceKind":"chat","sourceId":"chat-one"});
        assert!(matches!(
            call(read.clone()),
            Err(DocumentationError::Invalid(_))
        ));
        call(serde_json::json!({"rootPath":"unused","operation":"selectSources","documentId":"one","revision":1,"sources":[{"kind":"chat","id":"chat-one","label":"untrusted label"}]})).unwrap();
        assert!(!root.join("alcy-documents/one/sources").exists());
        assert_eq!(store.load("one").unwrap().sources[0].label, "Investigation");
        let first = call(read.clone()).unwrap();
        assert_eq!(first["fromSnapshot"], false);
        assert!(first["page"]["nextOffset"].is_number());
        sources.0.set(false);
        let fallback = call(read.clone()).unwrap();
        assert_eq!(fallback["fromSnapshot"], true);
        assert_eq!(fallback["page"], first["page"]);
        let mut unread = read.clone();
        unread["offset"] = first["page"]["nextOffset"].clone();
        assert!(matches!(call(unread), Err(DocumentationError::NotFound)));
        fs::write(
            root.join("alcy-documents/one/sources/chat-chat-one-0.txt"),
            vec![b'x'; 32 * 1024 + 1],
        )
        .unwrap();
        assert!(matches!(call(read), Err(DocumentationError::Invalid(_))));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn image_import_normalizes_pixels_and_markdown_assets_are_portable() {
        let root = std::env::temp_dir().join(format!(
            "alcy-doc-image-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = DocumentationStore::new(root.clone());
        create_document(&store, "image".into(), "Evidence".into(), 1).unwrap();
        assert!(
            store
                .add_image("image", "Invalid".into(), b"not a PNG", 1)
                .is_err()
        );
        assert!(matches!(
            store.add_image_cancellable(
                "image",
                "Cancelled".into(),
                b"unused",
                1,
                &std::sync::atomic::AtomicBool::new(true)
            ),
            Err(DocumentationError::Cancelled)
        ));
        assert!(store.load("image").unwrap().assets.is_empty());
        let image = image::DynamicImage::new_rgb8(320, 1800);
        let mut bytes = std::io::Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        let doc = store
            .add_image("image", "Local evidence".into(), &bytes.into_inner(), 1)
            .unwrap();
        let asset = &doc.assets[0];
        let path = root.join("evidence.md");
        store.export_markdown(&doc, &path).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains(&format!("evidence.assets/{}.png", asset.id)));
        assert_eq!(
            store.read_asset("image", &asset.id).unwrap(),
            fs::read(root.join(format!("evidence.assets/{}.png", asset.id))).unwrap()
        );
        let pdf = root.join("evidence.pdf");
        crate::export_document_pdf(
            &store,
            &doc,
            &pdf,
            &alcy_app::DocumentExportOptions {
                theme: alcy_app::DocumentThemes::default().resolve(None),
                labels: alcy_app::DocumentLabels::for_language("en"),
            },
            &std::sync::atomic::AtomicBool::new(false),
        )
        .unwrap();
        let bytes = fs::read(pdf).unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
        let parsed = printpdf::PdfDocument::parse(
            &bytes,
            &printpdf::PdfParseOptions::default(),
            &mut vec![],
        )
        .unwrap();
        assert!(
            parsed.pages.len() >= 3,
            "Tall captures must stay legible across multiple pages."
        );
        assert!(store.read_asset("image", "../outside").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_document_directories() {
        let root = std::env::temp_dir().join(format!(
            "alcy-doc-symlink-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let external = root.join("outside");
        fs::create_dir(&external).unwrap();
        std::os::unix::fs::symlink(&external, root.join("alcy-documents")).unwrap();
        let store = DocumentationStore::new(root.clone());
        assert!(create_document(&store, "one".into(), "Evidence".into(), 1).is_err());
        assert!(fs::read_dir(external).unwrap().next().is_none());
        fs::remove_dir_all(root).unwrap();
    }
}
