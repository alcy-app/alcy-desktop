import { formatResponseText } from './response-text-format'
import type { ResponseWorkerRequest, ResponseWorkerResult } from './response-format.worker'
import { monitorCandidates } from './value-monitor-candidates'
import type { MonitorCandidates } from './value-monitor-candidates'

type FormatLanguage = 'json' | 'xml'

/**
 * Abaixo do limiar, formatar é rápido o bastante (poucos ms) para acontecer
 * de forma síncrona sem perceptível — mesmo comportamento de sempre, sem
 * flash de conteúdo bruto. Igual ou acima, o parse+stringify vai para
 * `formatOffMainThread` (spec 0040): evita bloquear a thread principal
 * quando o auto-carregamento em segundo plano (`ResponseBody.tsx`) ou um
 * "mostrar tudo" manual terminam de reunir um documento de vários MB. O
 * monitor de valores usa o mesmo limiar para indexar os candidatos.
 */
export const WORKER_FORMAT_THRESHOLD_BYTES = 512 * 1024

let worker: Worker | null | undefined
const pending = new Map<number, (result: ResponseWorkerResult) => void>()
let nextId = 0

/**
 * Cria o worker sob demanda, uma única vez. Falha de criação (ex.: `Worker`
 * indisponível em `jsdom` nos testes) é tratada como "sem worker neste
 * ambiente" — `formatOffMainThread` cai para o formatador síncrono, com o
 * mesmo resultado.
 */
function getWorker(): Worker | null {
  if (worker !== undefined) return worker

  try {
    const instance = new Worker(new URL('./response-format.worker.ts', import.meta.url), { type: 'module' })
    instance.onmessage = (event: MessageEvent<ResponseWorkerResult>) => {
      const resolve = pending.get(event.data.id)
      if (resolve) {
        pending.delete(event.data.id)
        resolve(event.data)
      }
    }
    worker = instance
  } catch {
    worker = null
  }

  return worker
}

interface QueuedFormat {
  text: string
  language: FormatLanguage
  partial: boolean
  resolve: (formatted: string | null) => void
}

/**
 * Fila de formatação de uma visualização. Durante o carregamento progressivo
 * de um corpo grande, o texto muda várias vezes antes de a formatação
 * anterior terminar; sem coalescer, cada versão (cada vez maior) ia para o
 * worker e era formatada inteira, só para o resultado ser descartado. Com o
 * canal, fica no máximo um pedido em execução e um na espera: um pedido novo
 * substitui o que esperava, que resolve com `null` (descartado).
 */
export interface FormatChannel {
  inFlight: boolean
  queued: QueuedFormat | null
}

export function createFormatChannel(): FormatChannel {
  return { inFlight: false, queued: null }
}

/**
 * Formata `text` fora da thread principal quando possível (spec 0040); cai
 * para o formatador síncrono existente sem worker disponível. Com `channel`,
 * resolve com `null` quando um pedido mais novo do mesmo canal o substituiu
 * antes de começar.
 */
export function formatOffMainThread(
  text: string,
  language: FormatLanguage,
  { partial = false, channel }: { partial?: boolean; channel?: FormatChannel } = {},
): Promise<string | null> {
  const activeWorker = getWorker()
  if (!activeWorker) return Promise.resolve(formatResponseText(text, language, partial))
  if (!channel) return formatInWorker(activeWorker, text, language, partial)

  return new Promise((resolve) => {
    channel.queued?.resolve(null)
    channel.queued = { text, language, partial, resolve }
    pumpChannel(activeWorker, channel)
  })
}

function pumpChannel(activeWorker: Worker, channel: FormatChannel) {
  const job = channel.queued
  if (channel.inFlight || job === null) return
  channel.queued = null
  channel.inFlight = true
  void formatInWorker(activeWorker, job.text, job.language, job.partial).then((formatted) => {
    channel.inFlight = false
    job.resolve(formatted)
    pumpChannel(activeWorker, channel)
  })
}

function formatInWorker(activeWorker: Worker, text: string, language: FormatLanguage, partial: boolean): Promise<string> {
  return postToWorker(activeWorker, { kind: 'format', id: nextId++, text, language, partial }).then((result) =>
    result.kind === 'format' ? result.formatted : text,
  )
}

/** Candidatos do monitor de valores (`monitorCandidates`) fora da thread principal, com o mesmo fallback síncrono. */
export function monitorCandidatesOffMainThread(text: string, lastKeys: string[]): Promise<MonitorCandidates> {
  const activeWorker = getWorker()
  if (!activeWorker) return Promise.resolve(monitorCandidates(text, lastKeys))

  return postToWorker(activeWorker, { kind: 'monitorCandidates', id: nextId++, text, lastKeys }).then((result) =>
    result.kind === 'monitorCandidates' ? result.result : { candidates: [], truncated: false },
  )
}

function postToWorker(activeWorker: Worker, request: ResponseWorkerRequest): Promise<ResponseWorkerResult> {
  return new Promise((resolve) => {
    pending.set(request.id, resolve)
    activeWorker.postMessage(request)
  })
}
