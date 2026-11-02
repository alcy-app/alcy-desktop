import type { WebSocketEventDto } from '../../bindings/execute-websocket-request'
import type { ExecuteRestRequestError } from '../../bindings/execute-rest-request'

/** Live view of a WebSocket connection (spec 0140), bounded independently
 * of the final response body. */
export interface WebSocketStreamState {
  startedAt?: number
  status: 'connecting' | 'open' | 'closing' | 'closed'
  events: WebSocketEventDto[]
  dropped: number
  busy: boolean
  error: ExecuteRestRequestError | null
}

export const emptyWebSocketStream: WebSocketStreamState = {
  status: 'connecting',
  events: [],
  dropped: 0,
  busy: false,
  error: null,
}

const MAX_EVENTS = 500
const MAX_DATA_CHARS = 1024 * 1024

export function appendWebSocketEvent(state: WebSocketStreamState, event: WebSocketEventDto): WebSocketStreamState {
  const events = [...state.events, event]
  let chars = events.reduce((sum, item) => sum + (item.type === 'message' ? item.data.length : 0), 0)
  let dropped = state.dropped
  while (events.length > MAX_EVENTS || chars > MAX_DATA_CHARS) {
    const removed = events.shift()!
    if (removed.type === 'message') chars -= removed.data.length
    dropped++
  }
  const status =
    event.type === 'opened' ? 'open' : event.type === 'closed' ? 'closed' : state.status
  return { ...state, events, dropped, status }
}
