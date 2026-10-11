import { useCallback, useEffect, useState } from 'react'
import { compareRequestSends } from '../../bindings/compare-request-sends'
import type { ResponseComparisonDto } from '../../bindings/compare-request-sends'
import { getHistoryEntry } from '../../bindings/get-history-entry'
import { listRequestSends } from '../../bindings/list-request-sends'
import type { RequestSendDto, RequestSendsSource } from '../../bindings/list-request-sends'
import { releaseResponseBody } from '../../bindings/release-response-body'
import { setSendBaseline } from '../../bindings/set-send-baseline'
import { historyDetailToExecutionState } from './history'
import type { ExecutionState } from './request-workbench.types'

export type SendsState = { status: 'loading' } | { status: 'ready'; sends: RequestSendDto[] } | { status: 'error' }

/** A gravação no histórico não é aguardada pelo envio: se o envio atual ainda não aparece, lista de novo uma vez após esse intervalo. */
const MISSING_CURRENT_RETRY_MS = 400

/**
 * Envios da requisição (ou da aba) e a troca do baseline. Só lista a partir
 * do momento em que `enabled` fica verdadeiro; depois, recarrega a cada novo
 * envio e a cada `reload`. A lista pertence à origem que a pediu: ao trocar
 * de aba, volta a `loading` em vez de mostrar os envios da aba anterior.
 */
export function useRequestSends(source: RequestSendsSource, currentSendId: string | null, enabled: boolean) {
  const { rootPath, requestId, tabId } = source
  const sourceKey = `${rootPath}\n${requestId ?? ''}\n${tabId ?? ''}`
  const [loaded, setLoaded] = useState<{ key: string; state: SendsState } | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined

    const load = async (retryIfMissing: boolean) => {
      const result = await listRequestSends({ rootPath, requestId, tabId })
      if (cancelled) return
      if (!result.ok) {
        setLoaded({ key: sourceKey, state: { status: 'error' } })
        return
      }
      setLoaded({ key: sourceKey, state: { status: 'ready', sends: result.value } })
      const missingCurrent = currentSendId !== null && !result.value.some((send) => send.id === currentSendId)
      if (retryIfMissing && missingCurrent) {
        retry = setTimeout(() => void load(false), MISSING_CURRENT_RETRY_MS)
      }
    }

    void load(true)
    return () => {
      cancelled = true
      if (retry !== undefined) clearTimeout(retry)
    }
  }, [enabled, sourceKey, rootPath, requestId, tabId, currentSendId, reloadToken])

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])

  /** Devolve `false` quando a troca falhou (a lista é recarregada do disco). */
  const changeBaseline = useCallback(
    async (id: string | null): Promise<boolean> => {
      // Otimista: a marcação aparece na hora; uma falha recarrega a lista do disco.
      setLoaded((current) =>
        current?.key === sourceKey && current.state.status === 'ready'
          ? {
              key: current.key,
              state: { status: 'ready', sends: current.state.sends.map((send) => ({ ...send, baseline: send.id === id })) },
            }
          : current,
      )
      const result = await setSendBaseline({ rootPath, requestId, tabId }, id)
      if (!result.ok) setReloadToken((token) => token + 1)
      return result.ok
    },
    [sourceKey, rootPath, requestId, tabId],
  )

  const state: SendsState = loaded?.key === sourceKey ? loaded.state : { status: 'loading' }
  return { state, changeBaseline, reload }
}

export type PastSendState = { status: 'loading' } | { status: 'ready'; execution: ExecutionState } | { status: 'error' }

/** Resposta de um envio anterior, lida do histórico. Um corpo grande (janelado) é liberado do cache ao trocar de envio ou sair. */
export function usePastSend(rootPath: string, sendId: string | null): PastSendState | null {
  const [loaded, setLoaded] = useState<{ id: string; state: PastSendState } | null>(null)

  useEffect(() => {
    if (sendId === null) return
    let cancelled = false
    let handle: string | null = null

    void getHistoryEntry(rootPath, sendId).then((result) => {
      const execution = result.ok ? historyDetailToExecutionState(result.value) : null
      if (execution?.status === 'success' && execution.result.body.kind === 'windowed') {
        handle = execution.result.body.handle
      }
      if (cancelled) {
        if (handle !== null) void releaseResponseBody(handle)
        return
      }
      setLoaded({ id: sendId, state: execution ? { status: 'ready', execution } : { status: 'error' } })
    })

    return () => {
      cancelled = true
      if (handle !== null) void releaseResponseBody(handle)
    }
  }, [rootPath, sendId])

  if (sendId === null) return null
  return loaded?.id === sendId ? loaded.state : { status: 'loading' }
}

export type ComparisonState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; comparison: ResponseComparisonDto }
  /** `notStored`: a resposta de um dos envios não foi guardada no histórico. */
  | { status: 'error'; notStored: boolean }

/** Diff entre dois envios, calculado no backend. O resultado fica associado ao par que o
 * pediu: enquanto o do par atual não chega, o estado é `loading` e respostas de pares anteriores
 * são descartadas. */
export function useSendComparison(
  rootPath: string,
  baseId: string | null,
  targetId: string | null,
): ComparisonState {
  const key = baseId === null || targetId === null ? null : `${rootPath}\n${baseId}\n${targetId}`
  const [result, setResult] = useState<{ key: string; state: ComparisonState } | null>(null)

  useEffect(() => {
    if (key === null || baseId === null || targetId === null) return
    let cancelled = false
    void compareRequestSends({ rootPath, baseId, targetId }).then((response) => {
      if (cancelled) return
      setResult({
        key,
        state: response.ok
          ? { status: 'ready', comparison: response.value }
          : { status: 'error', notStored: response.error.kind === 'responseNotStored' },
      })
    })
    return () => {
      cancelled = true
    }
  }, [key, rootPath, baseId, targetId])

  if (key === null) return { status: 'idle' }
  return result?.key === key ? result.state : { status: 'loading' }
}
