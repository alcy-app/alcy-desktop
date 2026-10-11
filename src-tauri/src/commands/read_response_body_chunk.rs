use serde::{Deserialize, Serialize};

use crate::commands::response_body_cache::{ResponseBodyCache, char_boundary_window};

/// Tamanho de cada janela lida sob demanda de um corpo `Windowed` de
/// `execute_graphql_request`. 1 MiB: um corpo de 20 MB carrega em ~20 idas
/// e voltas pelo IPC em vez de ~100, e cada uma ainda é pequena o bastante
/// para não pesar na serialização.
const RESPONSE_BODY_CHUNK_BYTES: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResponseBodyChunkInput {
    pub handle: String,
    pub offset: usize,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadResponseBodyChunkOutput {
    pub chunk: String,
    pub next_offset: Option<usize>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReadResponseBodyChunkError {
    NotFound,
}

/// Lê a próxima janela de um corpo de resposta guardado em
/// `ResponseBodyCache` (ver `execute_graphql_request`, ramo `Windowed`).
/// Falha com `NotFound` quando o handle nunca existiu, já foi liberado
/// (`release_response_body`) ou foi despejado pelo cap de capacidade do
/// cache.
///
/// `async`: a cópia da janela e a serialização da resposta acontecem fora
/// da thread principal, que um command síncrono ocuparia.
#[tauri::command]
pub async fn read_response_body_chunk(
    input: ReadResponseBodyChunkInput,
    cache: tauri::State<'_, ResponseBodyCache>,
) -> Result<ReadResponseBodyChunkOutput, ReadResponseBodyChunkError> {
    read_response_body_chunk_inner(input, &cache)
}

fn read_response_body_chunk_inner(
    input: ReadResponseBodyChunkInput,
    cache: &ResponseBodyCache,
) -> Result<ReadResponseBodyChunkOutput, ReadResponseBodyChunkError> {
    let body = cache
        .get(&input.handle)
        .ok_or(ReadResponseBodyChunkError::NotFound)?;

    let (chunk, next_offset) = char_boundary_window(&body, input.offset, RESPONSE_BODY_CHUNK_BYTES);

    Ok(ReadResponseBodyChunkOutput {
        chunk: chunk.to_string(),
        next_offset,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn fails_with_not_found_for_an_unknown_handle() {
        let cache = ResponseBodyCache::new(5);

        let error = read_response_body_chunk_inner(
            ReadResponseBodyChunkInput {
                handle: "does-not-exist".to_string(),
                offset: 0,
            },
            &cache,
        )
        .unwrap_err();

        assert_eq!(error, ReadResponseBodyChunkError::NotFound);
    }

    #[test]
    fn reads_sequential_chunks_until_the_body_is_exhausted() {
        let cache = ResponseBodyCache::new(5);
        let body = "x".repeat(RESPONSE_BODY_CHUNK_BYTES * 2 + 10);
        cache.insert("exec-1".to_string(), Arc::from(body.as_str()));

        let first = read_response_body_chunk_inner(
            ReadResponseBodyChunkInput {
                handle: "exec-1".to_string(),
                offset: 0,
            },
            &cache,
        )
        .unwrap();
        assert_eq!(first.chunk.len(), RESPONSE_BODY_CHUNK_BYTES);
        assert_eq!(first.next_offset, Some(RESPONSE_BODY_CHUNK_BYTES));

        let second = read_response_body_chunk_inner(
            ReadResponseBodyChunkInput {
                handle: "exec-1".to_string(),
                offset: first.next_offset.unwrap(),
            },
            &cache,
        )
        .unwrap();
        assert_eq!(second.chunk.len(), RESPONSE_BODY_CHUNK_BYTES);
        assert_eq!(second.next_offset, Some(RESPONSE_BODY_CHUNK_BYTES * 2));

        let third = read_response_body_chunk_inner(
            ReadResponseBodyChunkInput {
                handle: "exec-1".to_string(),
                offset: second.next_offset.unwrap(),
            },
            &cache,
        )
        .unwrap();
        assert_eq!(third.chunk.len(), 10);
        assert_eq!(third.next_offset, None);
    }

    #[test]
    fn never_splits_a_multi_byte_character_across_a_chunk_boundary() {
        let cache = ResponseBodyCache::new(5);
        // "é" (2 bytes) posicionado para cair exatamente na fronteira do
        // primeiro chunk se o corte fosse feito por byte cru.
        let body = format!("{}é", "x".repeat(RESPONSE_BODY_CHUNK_BYTES - 1));
        cache.insert("exec-1".to_string(), Arc::from(body.as_str()));

        let first = read_response_body_chunk_inner(
            ReadResponseBodyChunkInput {
                handle: "exec-1".to_string(),
                offset: 0,
            },
            &cache,
        )
        .unwrap();

        // O byte cru RESPONSE_BODY_CHUNK_BYTES cairia no meio de "é" (2
        // bytes); a janela deve avançar até incluir o caractere inteiro.
        assert_eq!(first.chunk.len(), RESPONSE_BODY_CHUNK_BYTES + 1);
        assert!(first.chunk.ends_with('é'));
        assert_eq!(first.next_offset, None);
    }
}
