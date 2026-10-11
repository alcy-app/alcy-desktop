use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

/// Quantidade máxima de corpos de resposta grandes retidos simultaneamente.
/// O cap é a garantia
/// estrutural de memória limitada, independente de o frontend liberar
/// handles em todo caminho possível.
pub const RESPONSE_BODY_CACHE_CAPACITY: usize = 5;

/// Soma máxima, em bytes, dos corpos retidos. O teto de entradas sozinho não
/// limita memória — cinco corpos de 300 MB ainda seriam 1,5 GB —, então as
/// entradas mais antigas também saem enquanto a soma passar deste valor.
/// A entrada recém-inserida nunca é descartada por isso: é a que o usuário
/// está vendo, mesmo que sozinha exceda o orçamento.
pub const RESPONSE_BODY_CACHE_MAX_BYTES: usize = 256 * 1024 * 1024;

#[derive(Default)]
struct CacheState {
    bodies: HashMap<String, Arc<str>>,
    /// Soma de `len()` de todos os corpos em `bodies`.
    total_bytes: usize,
    /// Ordem de inserção, para descartar a entrada mais antiga ao exceder a
    /// capacidade. Um handle nunca aparece duas vezes: `insert` sobre um
    /// handle já presente substitui o corpo sem duplicar a posição.
    order: VecDeque<String>,
}

/// Cache em memória de corpos de resposta grandes demais para atravessar o
/// IPC por inteiro, indexado pelo `execution_id` que já corre pelo resto do
/// fluxo de execução (cancelamento, histórico). Só existe enquanto o
/// processo roda — sem persistência, sem requisito de durabilidade.
pub struct ResponseBodyCache {
    capacity: usize,
    max_bytes: usize,
    state: Mutex<CacheState>,
}

impl ResponseBodyCache {
    pub fn new(capacity: usize) -> Self {
        Self::with_byte_budget(capacity, RESPONSE_BODY_CACHE_MAX_BYTES)
    }

    pub fn with_byte_budget(capacity: usize, max_bytes: usize) -> Self {
        Self {
            capacity,
            max_bytes,
            state: Mutex::new(CacheState::default()),
        }
    }

    pub fn insert(&self, handle: String, body: Arc<str>) {
        let mut state = self.lock_state();
        state.total_bytes += body.len();
        match state.bodies.insert(handle.clone(), body) {
            Some(previous) => state.total_bytes -= previous.len(),
            None => state.order.push_back(handle),
        }
        while state.order.len() > self.capacity
            || (state.total_bytes > self.max_bytes && state.order.len() > 1)
        {
            let Some(oldest) = state.order.pop_front() else {
                break;
            };
            if let Some(evicted) = state.bodies.remove(&oldest) {
                state.total_bytes -= evicted.len();
            }
        }
    }

    pub fn get(&self, handle: &str) -> Option<Arc<str>> {
        self.lock_state().bodies.get(handle).cloned()
    }

    pub fn remove(&self, handle: &str) {
        let mut state = self.lock_state();
        if let Some(removed) = state.bodies.remove(handle) {
            state.total_bytes -= removed.len();
        }
        state.order.retain(|entry| entry != handle);
    }

    fn lock_state(&self) -> MutexGuard<'_, CacheState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.lock_state().bodies.len()
    }

    #[cfg(test)]
    fn total_bytes(&self) -> usize {
        self.lock_state().total_bytes
    }
}

impl Default for ResponseBodyCache {
    fn default() -> Self {
        Self::new(RESPONSE_BODY_CACHE_CAPACITY)
    }
}

/// Devolve a janela de `body` começando em `start` com até `want` bytes,
/// ajustando início e fim para a fronteira de caractere UTF-8 válida mais
/// próxima (nunca corta um caractere multi-byte ao meio). O segundo valor é
/// o offset da próxima janela, ou `None` quando a janela alcança o fim do
/// corpo.
pub fn char_boundary_window(body: &str, start: usize, want: usize) -> (&str, Option<usize>) {
    let len = body.len();
    let mut start = start.min(len);
    while start < len && !body.is_char_boundary(start) {
        start += 1;
    }
    let mut end = (start + want).min(len);
    while end < len && !body.is_char_boundary(end) {
        end += 1;
    }
    let next_offset = if end < len { Some(end) } else { None };
    (&body[start..end], next_offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_then_get_round_trips_the_body() {
        let cache = ResponseBodyCache::new(5);
        cache.insert("exec-1".to_string(), Arc::from("hello"));

        assert_eq!(cache.get("exec-1").as_deref(), Some("hello"));
    }

    #[test]
    fn get_returns_none_for_an_unknown_handle() {
        let cache = ResponseBodyCache::new(5);

        assert_eq!(cache.get("does-not-exist"), None);
    }

    #[test]
    fn remove_is_idempotent_for_an_unknown_handle() {
        let cache = ResponseBodyCache::new(5);

        cache.remove("does-not-exist");

        assert_eq!(cache.len(), 0);
    }

    #[test]
    fn remove_drops_the_entry() {
        let cache = ResponseBodyCache::new(5);
        cache.insert("exec-1".to_string(), Arc::from("hello"));

        cache.remove("exec-1");

        assert_eq!(cache.get("exec-1"), None);
        assert_eq!(cache.len(), 0);
    }

    #[test]
    fn inserting_over_an_existing_handle_replaces_the_body_without_growing() {
        let cache = ResponseBodyCache::new(5);
        cache.insert("exec-1".to_string(), Arc::from("first"));
        cache.insert("exec-1".to_string(), Arc::from("second"));

        assert_eq!(cache.get("exec-1").as_deref(), Some("second"));
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn evicts_the_oldest_entry_once_capacity_is_exceeded() {
        let cache = ResponseBodyCache::new(2);
        cache.insert("exec-1".to_string(), Arc::from("a"));
        cache.insert("exec-2".to_string(), Arc::from("b"));
        cache.insert("exec-3".to_string(), Arc::from("c"));

        assert_eq!(cache.get("exec-1"), None);
        assert_eq!(cache.get("exec-2").as_deref(), Some("b"));
        assert_eq!(cache.get("exec-3").as_deref(), Some("c"));
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn evicts_the_oldest_entries_once_the_byte_budget_is_exceeded() {
        let cache = ResponseBodyCache::with_byte_budget(5, 10);
        cache.insert("exec-1".to_string(), Arc::from("aaaa"));
        cache.insert("exec-2".to_string(), Arc::from("bbbb"));
        cache.insert("exec-3".to_string(), Arc::from("cccc"));

        assert_eq!(cache.get("exec-1"), None);
        assert_eq!(cache.get("exec-2").as_deref(), Some("bbbb"));
        assert_eq!(cache.get("exec-3").as_deref(), Some("cccc"));
        assert_eq!(cache.total_bytes(), 8);
    }

    #[test]
    fn keeps_a_single_body_larger_than_the_byte_budget() {
        let cache = ResponseBodyCache::with_byte_budget(5, 4);
        cache.insert("exec-1".to_string(), Arc::from("aa"));
        cache.insert("exec-2".to_string(), Arc::from("much larger than four"));

        assert_eq!(cache.get("exec-1"), None);
        assert_eq!(
            cache.get("exec-2").as_deref(),
            Some("much larger than four")
        );
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn tracks_bytes_across_replace_and_remove() {
        let cache = ResponseBodyCache::with_byte_budget(5, 100);
        cache.insert("exec-1".to_string(), Arc::from("12345"));
        cache.insert("exec-1".to_string(), Arc::from("12"));
        assert_eq!(cache.total_bytes(), 2);

        cache.insert("exec-2".to_string(), Arc::from("123"));
        cache.remove("exec-1");
        assert_eq!(cache.total_bytes(), 3);

        cache.remove("exec-2");
        assert_eq!(cache.total_bytes(), 0);
    }

    #[test]
    fn char_boundary_window_reads_sequential_chunks_until_exhausted() {
        let body = "abcdefghij";

        let (chunk, next) = char_boundary_window(body, 0, 4);
        assert_eq!(chunk, "abcd");
        assert_eq!(next, Some(4));

        let (chunk, next) = char_boundary_window(body, 4, 4);
        assert_eq!(chunk, "efgh");
        assert_eq!(next, Some(8));

        let (chunk, next) = char_boundary_window(body, 8, 4);
        assert_eq!(chunk, "ij");
        assert_eq!(next, None);
    }

    #[test]
    fn char_boundary_window_never_splits_a_multi_byte_character() {
        // "é" ocupa 2 bytes em UTF-8; pedir uma janela de 1 byte a partir do
        // início não pode cortar o caractere ao meio.
        let body = "éx";

        let (chunk, next) = char_boundary_window(body, 0, 1);

        assert_eq!(chunk, "é");
        assert_eq!(next, Some(2));
    }

    #[test]
    fn char_boundary_window_clamps_an_out_of_range_start_to_the_end() {
        let body = "abc";

        let (chunk, next) = char_boundary_window(body, 100, 4);

        assert_eq!(chunk, "");
        assert_eq!(next, None);
    }
}
