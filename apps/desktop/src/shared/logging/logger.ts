import { writeFrontendLogs, type FrontendLogEntry, type FrontendLogLevel } from '../../bindings/write-frontend-logs'

/**
 * Logger do frontend: agrupa eventos e envia ao log local do app (ver
 * `src-tauri/src/logging.rs`) a cada poucos segundos — nunca uma IPC por
 * evento. Mesma regra de privacidade do backend: registre ids, tipos,
 * contagens e estados; nunca headers, corpos, tokens, valores de variáveis
 * ou URLs com query string (query e fragmento são cortados por garantia).
 */

const FLUSH_INTERVAL_MS = 2000
const MAX_QUEUE = 500
const MAX_MESSAGE_CHARS = 1500

let queue: FrontendLogEntry[] = []
let timer: ReturnType<typeof setTimeout> | null = null

/** Corta query string e fragmento de qualquer URL no texto. */
export function scrubUrls(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, '$1?…')
}

function describe(data: unknown): string {
  if (data === undefined) return ''
  if (data instanceof Error) return `${data.name}: ${data.message}`
  if (typeof data === 'string') return data
  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}

function format(message: string, data: unknown): string {
  const detail = describe(data)
  const full = scrubUrls(detail ? `${message} ${detail}` : message)
  return full.length > MAX_MESSAGE_CHARS ? `${full.slice(0, MAX_MESSAGE_CHARS)}…` : full
}

export function flushLogs(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  if (queue.length === 0) return
  const batch = queue
  queue = []
  void writeFrontendLogs(batch)
}

function push(level: FrontendLogLevel, scope: string, message: string, data?: unknown): void {
  if (queue.length >= MAX_QUEUE) queue.shift()
  queue.push({ level, scope, message: format(message, data) })
  if (level === 'error') {
    flushLogs()
  } else if (timer === null) {
    timer = setTimeout(flushLogs, FLUSH_INTERVAL_MS)
  }
}

export const logger = {
  info: (scope: string, message: string, data?: unknown) => push('info', scope, message, data),
  warn: (scope: string, message: string, data?: unknown) => push('warn', scope, message, data),
  error: (scope: string, message: string, data?: unknown) => push('error', scope, message, data),
}

let installed = false

/** Erros não tratados, rejeições de promise e o envio final ao sair. */
export function installGlobalLogHandlers(): void {
  if (installed) return
  installed = true
  window.addEventListener('error', (event) => {
    logger.error('window', 'erro não tratado', event.error ?? event.message)
  })
  window.addEventListener('unhandledrejection', (event) => {
    logger.error('window', 'promise rejeitada sem tratamento', event.reason)
  })
  window.addEventListener('pagehide', flushLogs)
  logger.info('app', `interface iniciada (${navigator.language}, ${window.innerWidth}x${window.innerHeight})`)
}
