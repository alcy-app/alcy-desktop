/** How a WebSocket request's composer message is sent (spec 0140). */
export type WebSocketMessageFormat = 'text' | 'json' | 'binary'

/** Subprotocols, message format and run options of a WebSocket request, as
 * saved and as sent over IPC. The message travels separately (the body). */
export interface WebSocketCallDto {
  subprotocols: string[]
  messageFormat: WebSocketMessageFormat
  /** Runs and flows: longest wait for replies; `null` uses the request timeout. */
  waitMs?: number | null
  /** Runs and flows: close after this many replies; `null` means 1, 0 waits for `waitMs`. */
  expectedMessages?: number | null
}
