import { useEffect, useState } from 'react'
import { getRequestDocs } from '../../bindings/get-request-docs'
import type { RequestDocsDto } from '../../bindings/get-request-docs'
import type { DocsRefDto } from '../../bindings/list-collections'

export type RequestDocsState =
  /** A requisição não tem documentação importada. */
  | { status: 'none' }
  | { status: 'loading' }
  /** A referência aponta para uma fonte que não existe neste workspace
   * (ex.: requisição trazida de outro workspace pelo formato Alcy). */
  | { status: 'missing' }
  | { status: 'error'; message: string }
  | { status: 'ready'; docs: RequestDocsDto }

type LoadedDocs = Extract<RequestDocsState, { status: 'missing' | 'error' | 'ready' }>

/** Poucas operações por sessão bastam: é o que alimenta a aba Docs e as
 * sugestões ao alternar entre abas abertas. */
const MAX_CACHED_OPERATIONS = 50
const cache = new Map<string, LoadedDocs>()

function remember(key: string, value: LoadedDocs) {
  cache.delete(key)
  cache.set(key, value)
  if (cache.size > MAX_CACHED_OPERATIONS) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

/**
 * Carrega sob demanda a documentação importada de uma requisição (ADR 0035).
 * `revision` muda quando `alcy-api-docs.json` é reescrito por fora (pull do
 * controle de versão) e força uma nova leitura. Erros não ficam em cache.
 */
export function useRequestDocs(rootPath: string, docsRef: DocsRefDto | null | undefined, revision = 0): RequestDocsState {
  const sourceId = docsRef?.sourceId ?? null
  const operationId = docsRef?.operationId ?? null
  const key = sourceId !== null && operationId !== null ? [revision, rootPath, sourceId, operationId].join('\u0000') : null
  const [loaded, setLoaded] = useState<{ key: string; value: LoadedDocs } | null>(null)

  useEffect(() => {
    if (key === null || sourceId === null || operationId === null || cache.has(key)) return
    let cancelled = false
    void getRequestDocs(rootPath, { sourceId, operationId }).then((result) => {
      let value: LoadedDocs
      if (!result.ok) {
        value = { status: 'error', message: result.error.message }
      } else {
        value = result.value === null ? { status: 'missing' } : { status: 'ready', docs: result.value }
        remember(key, value)
      }
      if (!cancelled) setLoaded({ key, value })
    })
    return () => {
      cancelled = true
    }
  }, [key, rootPath, sourceId, operationId])

  if (key === null) return { status: 'none' }
  const cached = cache.get(key)
  if (cached) return cached
  if (loaded?.key === key) return loaded.value
  return { status: 'loading' }
}
