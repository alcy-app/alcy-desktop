import { Channel, invoke } from '@tauri-apps/api/core'
import type { FlowEdgeDto, FlowNodeDto } from './list-flows'
import type { EnvironmentVariableDto } from './list-environments'
import type { ScopedVariableChange } from './execute-graphql-request'

export interface ExecuteFlowInput {
  flowExecutionId: string
  rootPath: string
  /** Só rotula o run no histórico. */
  flowName?: string
  nodes: FlowNodeDto[]
  edges: FlowEdgeDto[]
  environmentVariables: EnvironmentVariableDto[]
}

export type FlowNodeSkipReasonDto = 'notRunnable' | 'unreachable' | 'cancelled' | 'branchNotTaken' | 'loopInterrupted'

export interface CallVariableDto {
  name: string
  /** Mascarado pelo backend quando `sensitive`. */
  value: string
  sensitive: boolean
}

export type FlowRunEventDto =
  | { type: 'nodeStarted'; nodeId: string }
  | { type: 'nodeCallResolved'; nodeId: string; requestUrl: string; resolvedUrl: string; variables: CallVariableDto[] }
  | { type: 'nodeSucceeded'; nodeId: string; statusCode: number; durationMs: number }
  /** `If` ou bloco de mock com duas saídas; os blocos de mock explicam o
   * resultado em `message`. */
  | { type: 'nodeBranched'; nodeId: string; result: boolean; message?: string }
  | { type: 'nodeFailed'; nodeId: string; message: string }
  | { type: 'nodeCancelled'; nodeId: string }
  | { type: 'nodeSkipped'; nodeId: string; reason: FlowNodeSkipReasonDto }
  /** Conclusão de `log`/`display`/`setVariables`/`sleep`, com o texto já mascarado. */
  | { type: 'nodeCompleted'; nodeId: string; message: string | null }
  /** Um `while` começou a iteração `iteration` (a partir de 1); um evento por iteração. */
  | { type: 'nodeLoopIteration'; nodeId: string; iteration: number }
  /** Um `while` saiu pela saída `done`. */
  | { type: 'nodeLoopFinished'; nodeId: string; iterations: number }
  /** Efeitos dos scripts do run; emitido uma vez antes de `runFinished`, só quando houve algum. */
  | {
      type: 'scriptsFinished'
      environmentChanges: { name: string; value: string | null }[]
      /** Variáveis de coleção/pasta gravadas pelos scripts (ADR 0031). */
      scopedChanges: ScopedVariableChange[]
      logs: string[]
    }
  | { type: 'runFinished'; cancelled: boolean }

export type ExecuteFlowError =
  | { kind: 'invalidGraph'; message: string }
  | { kind: 'cyclicGraph' }
  | { kind: 'missingStartNode' }
  /** Corpo de um `while` aberto: algo dentro dele se conecta a fora, ou entra nele sem ser pela saída `loop`. */
  | { kind: 'invalidLoopBody'; whileNodeId: string }
  | { kind: 'storage'; message: string }

export type ExecuteFlowResult = { ok: true } | { ok: false; error: ExecuteFlowError }

/** Erros de pré-execução (grafo inválido/cíclico/sem Start/falha ao carregar
 * coleções) chegam pela rejeição da promise, sem nenhum evento em `onEvent`
 * — ver `execute_flow` (Rust). Um run normal só termina, do ponto de vista
 * do chamador, quando `onEvent` recebe `{ type: 'runFinished' }`; a promise
 * resolver é uma confirmação redundante desse mesmo instante. */
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
