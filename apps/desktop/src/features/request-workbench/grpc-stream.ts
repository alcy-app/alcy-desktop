import type { GrpcCallEventDto } from '../../bindings/execute-grpc-request'
import type { GrpcCommandError } from '../../bindings/load-grpc-schema'

export interface GrpcStreamState {
  events: GrpcCallEventDto[]
  dropped: number
  accepting: boolean
  busy: boolean
  error: GrpcCommandError | null
}

export const emptyGrpcStream: GrpcStreamState = { events: [], dropped: 0, accepting: false, busy: false, error: null }
const MAX_EVENTS = 500
const MAX_JSON_CHARS = 1024 * 1024

/** Bound the live preview independently of the final response body. */
export function appendGrpcEvent(state: GrpcStreamState, event: GrpcCallEventDto): GrpcStreamState {
  const events = [...state.events, event]
  let chars = events.reduce((sum, item) => sum + ('json' in item ? item.json.length : 0), 0)
  let dropped = state.dropped
  while (events.length > MAX_EVENTS || chars > MAX_JSON_CHARS) {
    const removed = events.shift()!
    if ('json' in removed) chars -= removed.json.length
    dropped++
  }
  return {
    ...state, events, dropped,
    accepting: event.type === 'started'
      ? event.kind === 'clientStreaming' || event.kind === 'bidiStreaming'
      : event.type === 'finished' ? false : state.accepting,
  }
}
