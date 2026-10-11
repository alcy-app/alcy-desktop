//! Texto embutido num PNG pelo "Compartilhar como imagem" (ADR 0032): um
//! chunk `iTXt` com a palavra-chave `IMPORT_PNG_KEYWORD` guarda a requisição
//! no formato Alcy, para a imagem poder ser importada de volta.

use super::CollectionImportError;

/// Palavra-chave do chunk de texto com os dados de importação — a mesma
/// usada pelo frontend ao gerar a imagem.
pub const IMPORT_PNG_KEYWORD: &str = "alcy.collections";

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

pub fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(&PNG_SIGNATURE)
}

fn invalid_png() -> CollectionImportError {
    CollectionImportError::Invalid("imagem PNG inválida".to_string())
}

/// Texto do primeiro chunk `iTXt` ou `tEXt` com a palavra-chave dada;
/// `None` quando o PNG não tem esse chunk.
pub fn png_text(bytes: &[u8], keyword: &str) -> Result<Option<String>, CollectionImportError> {
    let mut rest = bytes.strip_prefix(&PNG_SIGNATURE).ok_or_else(invalid_png)?;
    while !rest.is_empty() {
        let header = rest.get(..8).ok_or_else(invalid_png)?;
        let length = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
        let kind = &header[4..8];
        let end = length.checked_add(12).ok_or_else(invalid_png)?;
        let data = rest.get(8..8 + length).ok_or_else(invalid_png)?;
        rest = rest.get(end..).ok_or_else(invalid_png)?;

        let text = match kind {
            b"iTXt" => international_text(data, keyword)?,
            b"tEXt" => latin1_text(data, keyword),
            b"IEND" => break,
            _ => None,
        };
        if text.is_some() {
            return Ok(text);
        }
    }
    Ok(None)
}

/// `palavra-chave \0 compressão método idioma \0 palavra traduzida \0 texto`.
fn international_text(data: &[u8], keyword: &str) -> Result<Option<String>, CollectionImportError> {
    let Some(rest) = strip_keyword(data, keyword) else {
        return Ok(None);
    };
    let [compressed, _method, rest @ ..] = rest else {
        return Err(invalid_png());
    };
    if *compressed != 0 {
        return Err(CollectionImportError::Invalid(
            "dados de importação comprimidos na imagem não são suportados".to_string(),
        ));
    }
    let rest = split_after_nul(rest).ok_or_else(invalid_png)?;
    let text = split_after_nul(rest).ok_or_else(invalid_png)?;
    String::from_utf8(text.to_vec())
        .map(Some)
        .map_err(|_| invalid_png())
}

/// `palavra-chave \0 texto`, com o texto em Latin-1.
fn latin1_text(data: &[u8], keyword: &str) -> Option<String> {
    strip_keyword(data, keyword).map(|text| text.iter().copied().map(char::from).collect())
}

fn strip_keyword<'a>(data: &'a [u8], keyword: &str) -> Option<&'a [u8]> {
    data.strip_prefix(keyword.as_bytes())?.strip_prefix(&[0])
}

fn split_after_nul(data: &[u8]) -> Option<&[u8]> {
    let end = data.iter().position(|byte| *byte == 0)?;
    Some(&data[end + 1..])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = (data.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        // O CRC não é verificado na leitura.
        out.extend_from_slice(&[0; 4]);
        out
    }

    fn png(chunks: &[Vec<u8>]) -> Vec<u8> {
        let mut out = PNG_SIGNATURE.to_vec();
        out.extend(chunk(b"IHDR", &[0; 13]));
        for extra in chunks {
            out.extend_from_slice(extra);
        }
        out.extend(chunk(b"IEND", &[]));
        out
    }

    fn itxt(keyword: &str, compressed: u8, text: &str) -> Vec<u8> {
        let mut data = keyword.as_bytes().to_vec();
        data.extend_from_slice(&[0, compressed, 0]);
        data.extend_from_slice(b"pt\0\0");
        data.extend_from_slice(text.as_bytes());
        chunk(b"iTXt", &data)
    }

    #[test]
    fn reads_the_import_text_of_an_itxt_chunk() {
        let bytes = png(&[
            itxt("Comment", 0, "outro"),
            itxt(IMPORT_PNG_KEYWORD, 0, "{\"versão\":1}"),
        ]);

        assert!(is_png(&bytes));
        assert_eq!(
            png_text(&bytes, IMPORT_PNG_KEYWORD).unwrap(),
            Some("{\"versão\":1}".to_string())
        );
    }

    #[test]
    fn reads_a_latin1_text_chunk() {
        let mut data = IMPORT_PNG_KEYWORD.as_bytes().to_vec();
        data.push(0);
        data.extend_from_slice(&[b'a', 0xE9]);
        let bytes = png(&[chunk(b"tEXt", &data)]);

        assert_eq!(
            png_text(&bytes, IMPORT_PNG_KEYWORD).unwrap(),
            Some("aé".to_string())
        );
    }

    #[test]
    fn returns_none_without_the_chunk() {
        assert_eq!(png_text(&png(&[]), IMPORT_PNG_KEYWORD).unwrap(), None);
    }

    #[test]
    fn rejects_truncated_or_compressed_data() {
        let mut truncated = png(&[itxt(IMPORT_PNG_KEYWORD, 0, "texto")]);
        truncated.truncate(40);
        assert!(png_text(&truncated, IMPORT_PNG_KEYWORD).is_err());

        let compressed = png(&[itxt(IMPORT_PNG_KEYWORD, 1, "x")]);
        assert!(png_text(&compressed, IMPORT_PNG_KEYWORD).is_err());

        assert!(!is_png(b"{\"version\": 1}"));
    }
}
