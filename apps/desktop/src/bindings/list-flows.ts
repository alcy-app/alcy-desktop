import { invoke } from '@tauri-apps/api/core'
import type { SavedRequestDto } from './list-collections'
import type { MockServerDto } from './mock-servers'

export type ComparisonOperatorDto = 'equals' | 'notEquals' | 'greaterThan' | 'lessThan'

export interface ConditionDto {
  left: string
  operator: ComparisonOperatorDto
  right: string
}

export type VariableAssignmentDto = { name: string } & (
  | { operation: 'set'; value: string }
  | { operation: 'increment'; by: number }
)

export type FlowExecutionKindDto = 'standard' | 'load'

/** Blocos declarativos disponíveis exclusivamente em flows de carga. A
 * configuração fica serializada no backend para que novos campos possam ser
 * adicionados sem alargar o contrato do canvas a cada executor. */
export type LoadNodeKindDto =
  | 'scenario'
  | 'request'
  | 'script'
  | 'repeat'
  | 'forEach'
  | 'oncePerVu'
  | 'timeBox'
  | 'select'
  | 'group'
  | 'timer'
  | 'dataset'
  | 'configureSession'
  | 'extract'
  | 'check'
  | 'metric'
  | 'threshold'

/** Mock ligado por um bloco `mockStart` (spec 0121): um mock salvo do
 * workspace ou um avulso, guardado inteiro no flow. */
export type MockServerSourceDto = { type: 'saved'; serverId: string } | { type: 'inline'; server: MockServerDto }

export type MockCallCountOperatorDto = 'equals' | 'atLeast' | 'atMost'

export type FlowNodeKindDto =
  | { kind: 'start' }
  | { kind: 'block'; label: string }
  | { kind: 'request'; requestId: string }
  | { kind: 'if'; condition: ConditionDto }
  | { kind: 'note'; text: string; width: number; height: number }
  | { kind: 'log'; message: string }
  | { kind: 'display'; template: string }
  | { kind: 'sleep'; durationMs: number }
  | { kind: 'setVariables'; assignments: VariableAssignmentDto[] }
  | { kind: 'while'; condition: ConditionDto; maxIterations: number }
  | { kind: 'break' }
  | { kind: 'continue' }
  | { kind: 'load'; loadKind: LoadNodeKindDto; label: string; config: string }
  /** Requisição avulsa: mesmo DTO de uma requisição de coleção. */
  | { kind: 'inlineRequest'; request: SavedRequestDto }
  /** Blocos de mock server (spec 0121): os demais apontam para o bloco
   * `mockStart` que ligou o mock. */
  | { kind: 'mockStart'; source: MockServerSourceDto }
  | { kind: 'mockStop'; startNodeId: string }
  | { kind: 'mockWaitRequest'; startNodeId: string; routeId: string; timeoutMs: number }
  | { kind: 'mockSetResponse'; startNodeId: string; routeId: string; responseId: string | null }
  | { kind: 'mockAssertCalls'; startNodeId: string; routeId: string; operator: MockCallCountOperatorDto; count: number }

export type FlowNodeDto = FlowNodeKindDto & {
  id: string
  x: number
  y: number
}

export interface FlowEdgeDto {
  id: string
  sourceNodeId: string
  targetNodeId: string
  /** `undefined`/`null` para toda edge saindo de um node de saída única;
   * `"true"`/`"false"` para as duas edges saindo de um `If` ou de um bloco de
   * mock com duas saídas. */
  sourceHandle?: string | null
}

export interface FlowDto {
  id: string
  name: string
  executionKind: FlowExecutionKindDto
  nodes: FlowNodeDto[]
  edges: FlowEdgeDto[]
  createdAtMs: number
  updatedAtMs: number
}

export interface FlowsSnapshotDto {
  flows: FlowDto[]
}

export type FlowsError = { kind: 'invalid'; message: string } | { kind: 'storage'; message: string }

export type ListFlowsResult = { ok: true; value: FlowsSnapshotDto } | { ok: false; error: FlowsError }

export async function listFlows(rootPath: string): Promise<ListFlowsResult> {
  try {
    const value = await invoke<FlowsSnapshotDto>('list_flows', { input: { rootPath } })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as FlowsError }
  }
}
