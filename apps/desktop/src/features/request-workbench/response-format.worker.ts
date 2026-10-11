import { formatResponseText } from './response-text-format'
import { monitorCandidates } from './value-monitor-candidates'
import type { MonitorCandidates } from './value-monitor-candidates'

export interface ResponseFormatRequest {
  kind: 'format'
  id: number
  text: string
  language: 'json' | 'xml'
  /** Corpo ainda carregando: JSON usa o formatador tolerante a documento truncado. */
  partial: boolean
}

/** Extração dos valores candidatos a monitoramento (`value-monitor-candidates.ts`). */
export interface MonitorCandidatesRequest {
  kind: 'monitorCandidates'
  id: number
  text: string
  lastKeys: string[]
}

export type ResponseWorkerRequest = ResponseFormatRequest | MonitorCandidatesRequest

export type ResponseWorkerResult =
  | { kind: 'format'; id: number; formatted: string }
  | { kind: 'monitorCandidates'; id: number; result: MonitorCandidates }

/**
 * Reformata (`JSON.parse`+`stringify`/indentação XML) e indexa candidatos
 * do monitor de valores — reaproveita as mesmas funções puras do main
 * thread, sem duplicar lógica nem conhecer CodeMirror. Existe para tirar o custo de parse+stringify de documentos
 * grandes da thread principal (spec 0040); quem decide chamar o worker (e
 * o fallback síncrono quando `Worker` não está disponível) é
 * `format-off-main-thread.ts`.
 */
self.onmessage = (event: MessageEvent<ResponseWorkerRequest>) => {
  const request = event.data
  const response: ResponseWorkerResult =
    request.kind === 'format'
      ? { kind: 'format', id: request.id, formatted: formatResponseText(request.text, request.language, request.partial) }
      : { kind: 'monitorCandidates', id: request.id, result: monitorCandidates(request.text, request.lastKeys) }
  ;(self as unknown as Worker).postMessage(response)
}
