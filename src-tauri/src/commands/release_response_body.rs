use serde::Deserialize;

use crate::commands::response_body_cache::ResponseBodyCache;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseResponseBodyInput {
    pub handle: String,
}

/// Remove um corpo de resposta do `ResponseBodyCache` antes do descarte
/// natural por capacidade — chamado pelo frontend quando um resultado
/// `windowed` deixa de ser referenciado por nenhuma aba aberta.
///
/// Idempotente: liberar um handle desconhecido (nunca existiu, ou já foi
/// liberado/despejado) não é erro.
#[tauri::command]
pub fn release_response_body(
    input: ReleaseResponseBodyInput,
    cache: tauri::State<'_, ResponseBodyCache>,
) {
    release_response_body_inner(input, &cache)
}

fn release_response_body_inner(input: ReleaseResponseBodyInput, cache: &ResponseBodyCache) {
    cache.remove(&input.handle);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn removes_the_cached_body() {
        let cache = ResponseBodyCache::new(5);
        cache.insert("exec-1".to_string(), Arc::from("hello"));

        release_response_body_inner(
            ReleaseResponseBodyInput {
                handle: "exec-1".to_string(),
            },
            &cache,
        );

        assert_eq!(cache.get("exec-1"), None);
    }

    #[test]
    fn is_a_no_op_for_an_unknown_handle() {
        let cache = ResponseBodyCache::new(5);

        release_response_body_inner(
            ReleaseResponseBodyInput {
                handle: "does-not-exist".to_string(),
            },
            &cache,
        );
    }
}
