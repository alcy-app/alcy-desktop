import { writeFrontendLogs, type FrontendLogEntry, type FrontendLogLevel } from '../../bindings/write-frontend-logs'

/**
 * Batch frontend events into the local app log (see `src-tauri/src/logging.rs`).
 * Follow backend privacy rules: log IDs, types, counts and states, never headers,
 * bodies, tokens or variable values. Strip URL credentials, queries and fragments.
 */

const FLUSH_INTERVAL_MS = 2000
const MAX_QUEUE = 500
const MAX_MESSAGE_CHARS = 1500

let queue: FrontendLogEntry[] = []
let timer: ReturnType<typeof setTimeout> | null = null

/** Strip credentials, query strings and fragments from URLs in log text. */
export function scrubUrls(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/"'<>]*@/gi, '$1')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, '$1?…')
}

function describeError(error: Error, seen = new Set<Error>()): string {
  if (seen.has(error) || seen.size >= 5) return '…'
  seen.add(error)
  const message = `${error.name}: ${error.message}`
  if (error.cause === undefined) return message
  const cause = describeCause(error.cause, seen)
  return `${message}; cause: ${cause}`
}

/** Error causes may carry request options; keep diagnostic fields only. */
function describeCause(cause: unknown, seen: Set<Error>, depth = 0): string {
  if (depth >= 5) return '…'
  if (cause instanceof Error) return describeError(cause, seen)
  if (cause === null || typeof cause !== 'object') return describe(cause, seen)
  const details: Record<string, string> = {}
  for (const key of ['name', 'message', 'kind', 'type', 'reason', 'cause', 'status']) {
    if (Object.hasOwn(cause, key)) {
      details[key] = describeCause((cause as Record<string, unknown>)[key], seen, depth + 1)
    }
  }
  return JSON.stringify(details)
}

function describe(data: unknown, seen = new Set<Error>()): string {
  if (data === undefined) return ''
  if (data instanceof Error) return describeError(data, seen)
  if (typeof data === 'string') return data
  try {
    return JSON.stringify(data, (_key, value: unknown) => value instanceof Error ? describeError(value, seen) : value)
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

/** Capture unhandled errors, promise rejections and the final flush on exit. */
export function installGlobalLogHandlers(): void {
  if (installed) return
  installed = true
  window.addEventListener('error', (event) => {
    logger.error('window', 'unhandled error', event.error ?? event.message)
  })
  window.addEventListener('unhandledrejection', (event) => {
    logger.error('window', 'unhandled promise rejection', event.reason)
  })
  window.addEventListener('pagehide', flushLogs)
  logger.info('app', `interface started (${navigator.language}, ${window.innerWidth}x${window.innerHeight})`)
}
