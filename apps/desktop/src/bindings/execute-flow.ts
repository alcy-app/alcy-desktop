import { Channel, invoke } from '@tauri-apps/api/core'
import type { FlowEdgeDto, FlowNodeDto } from './list-flows'
import type { EnvironmentVariableDto } from './list-environments'
import type { ConnectionInfo, Cookie, ResponseBodyEncoding, ResponseHeader, ScopedVariableChange } from './execute-graphql-request'

export interface ExecuteFlowInput {
  flowExecutionId: string
  rootPath: string
  /** Only labels the run in history. */
  flowName?: string
  nodes: FlowNodeDto[]
  edges: FlowEdgeDto[]
  environmentVariables: EnvironmentVariableDto[]
  /** Ask for one `nodeExchange` per response, for the HAR recorder. */
  recordExchanges?: boolean
}

export type FlowNodeSkipReasonDto = 'notRunnable' | 'unreachable' | 'cancelled' | 'branchNotTaken' | 'loopInterrupted'

export interface CallVariableDto {
  name: string
  /** Masked by the backend when `sensitive`. */
  value: string
  sensitive: boolean
}

/** Full call of a request node, only sent with `recordExchanges`. The response
 * body is capped to its start (`truncated`). */
export interface FlowExchangeDto {
  /** URL actually sent, with real values; `null` when it could not be resolved. */
  url: string | null
  statusCode: number
  durationMs: number
  sizeBytes: number
  body: string
  bodyEncoding: ResponseBodyEncoding
  truncated: boolean
  headers: ResponseHeader[]
  requestHeaders: ResponseHeader[]
  cookies: Cookie[]
  connection: ConnectionInfo
  finalUrl: string | null
  waitingMs: number
}

export type FlowRunEventDto =
  | { type: 'nodeStarted'; nodeId: string }
  | { type: 'nodeCallResolved'; nodeId: string; requestUrl: string; resolvedUrl: string; variables: CallVariableDto[] }
  | { type: 'nodeSucceeded'; nodeId: string; statusCode: number; durationMs: number }
  /** Arrives before the node's `nodeSucceeded`/`nodeFailed`; never recorded in history. */
  | { type: 'nodeExchange'; nodeId: string; exchange: FlowExchangeDto }
  /** `If` or a two-output mock block; mock blocks explain the result in `message`. */
  | { type: 'nodeBranched'; nodeId: string; result: boolean; message?: string }
  | { type: 'nodeFailed'; nodeId: string; message: string }
  | { type: 'nodeCancelled'; nodeId: string }
  | { type: 'nodeSkipped'; nodeId: string; reason: FlowNodeSkipReasonDto }
  /** `log`/`display`/`setVariables`/`sleep` finished, with the text already masked. */
  | { type: 'nodeCompleted'; nodeId: string; message: string | null }
  /** A `while` started iteration `iteration` (one-based); one event per iteration. */
  | { type: 'nodeLoopIteration'; nodeId: string; iteration: number }
  /** A `while` left through its `done` output. */
  | { type: 'nodeLoopFinished'; nodeId: string; iterations: number }
  /** The run's script effects; emitted once before `runFinished`, only when there were any. */
  | {
      type: 'scriptsFinished'
      environmentChanges: { name: string; value: string | null }[]
      /** Collection/folder variables written by scripts (ADR 0031). */
      scopedChanges: ScopedVariableChange[]
      logs: string[]
    }
  | { type: 'runFinished'; cancelled: boolean }

export type ExecuteFlowError =
  | { kind: 'invalidGraph'; message: string }
  | { kind: 'cyclicGraph' }
  | { kind: 'missingStartNode' }
  /** Open `while` body: something inside connects outside, or enters it other than through the `loop` output. */
  | { kind: 'invalidLoopBody'; whileNodeId: string }
  | { kind: 'storage'; message: string }

export type ExecuteFlowResult = { ok: true } | { ok: false; error: ExecuteFlowError }

/** Pre-run errors (invalid/cyclic graph, no Start, collections failing to load)
 * arrive as the promise rejection, with no event on `onEvent` — see
 * `execute_flow` (Rust). For the caller, a normal run only ends when `onEvent`
 * receives `{ type: 'runFinished' }`; the promise resolving is a redundant
 * confirmation of that same moment. */
export async function executeFlow(
  input: ExecuteFlowInput,
  onEvent: (event: FlowRunEventDto) => void,
): Promise<ExecuteFlowResult> {
  const channel = new Channel<FlowRunEventDto>()
  channel.onmessage = onEvent
  try {
    await invoke('execute_flow', { input, onEvent: channel })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error as ExecuteFlowError }
  }
}
