import type { GrpcCommandError } from '../../bindings/load-grpc-schema'
import { useCallback, useState } from 'react'
import type {
  ConnectionInfo,
  Cookie,
  ExecuteGraphqlRequestError,
  ResponseBodyEncoding,
  ResponseBodyOutput,
  ResponseHeader,
} from '../../bindings/execute-graphql-request'

const MAX_ENTRIES = 200

/**
 * Teto dos corpos (requisição e resposta em texto) guardados por entrada do
 * console. Com até `MAX_ENTRIES` entradas e corpos inline de até 1 MB, o
 * console sozinho podia reter centenas de MB de respostas antigas. O
 * gravador de HAR não passa por aqui e continua com o corpo completo.
 */
export const MAX_CONSOLE_BODY_CHARS = 64 * 1024

/** Dados só disponíveis quando a execução teve sucesso — usados pela seção
 * expandida de cada linha do console (Network/Request Headers/Cookies/
 * Response Headers/Response Body/Raw). Guardados à parte de `ConsoleEntry`
 * porque uma execução com erro nunca tem nada disso. */
export interface ConsoleEntryDetail {
  method: string
  requestBody: string
  durationMs: number
  requestHeaders: ResponseHeader[]
  cookies: Cookie[]
  connection: ConnectionInfo
  finalUrl: string | null
  waitingMs: number
  responseHeaders: ResponseHeader[]
  body: ResponseBodyOutput
  bodyEncoding: ResponseBodyEncoding
  /** Algum dos corpos passou de `MAX_CONSOLE_BODY_CHARS` e foi guardado só no início. */
  truncated?: boolean
}

function capConsoleDetail(detail: ConsoleEntryDetail): ConsoleEntryDetail {
  const requestTooLong = detail.requestBody.length > MAX_CONSOLE_BODY_CHARS
  // Base64 cortado não decodifica: imagens inline ficam inteiras.
  const responseTooLong =
    detail.bodyEncoding === 'text' && detail.body.kind === 'inline' && detail.body.body.length > MAX_CONSOLE_BODY_CHARS
  if (!requestTooLong && !responseTooLong) return detail
  return {
    ...detail,
    requestBody: requestTooLong ? detail.requestBody.slice(0, MAX_CONSOLE_BODY_CHARS) : detail.requestBody,
    body:
      responseTooLong && detail.body.kind === 'inline'
        ? { kind: 'inline', body: detail.body.body.slice(0, MAX_CONSOLE_BODY_CHARS) }
        : detail.body,
    truncated: true,
  }
}

export interface ConsoleEntry {
  id: string
  /** `request`: uma execução; `script`: um evento por `al.console.log` (ou por
   * falha de script) da execução (`endpointUrl` é o da requisição). */
  kind: 'request' | 'script'
  endpointUrl: string
  executedAtMs: number
  durationMs: number | null
  outcome: 'success' | 'error'
  statusCode: number | null
  hasGraphqlErrors: boolean
  errorKind: ExecuteGraphqlRequestError['kind'] | GrpcCommandError['kind'] | null
  /** Só em eventos `script`: a mensagem logada, ou a falha do script quando `outcome` é `error`. */
  scriptMessage: string | null
  detail: ConsoleEntryDetail | null
}

export type ConsoleEntryInput = Omit<ConsoleEntry, 'id'>

/** Log em memória das requisições enviadas nesta sessão, para o console de devtools do
 * app. Deliberadamente efêmero (não persiste em disco) — diferente do histórico
 * (`use-history-state.ts`), que é curado e sobrevive a reinícios do app. */
export function useConsoleState() {
  const [entries, setEntries] = useState<ConsoleEntry[]>([])

  /** Acrescenta várias entradas numa única atualização (ex.: os passos de um run, agrupados por quadro). */
  const appendMany = useCallback((batch: readonly ConsoleEntryInput[]) => {
    if (batch.length === 0) return
    setEntries((current) => {
      const added = batch.map((entry) => ({ ...entry, detail: entry.detail && capConsoleDetail(entry.detail), id: crypto.randomUUID() }))
      const next = [...current, ...added]
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
    })
  }, [])

  const append = useCallback((entry: ConsoleEntryInput) => {
    appendMany([entry])
  }, [appendMany])

  const clear = useCallback(() => {
    setEntries([])
  }, [])

  const remove = useCallback((id: string) => {
    setEntries((current) => current.filter((entry) => entry.id !== id))
  }, [])

  return { entries, append, appendMany, clear, remove }
}
