import type { MockServerDto } from '../../bindings/mock-servers'
import type { RequestSummary } from '../request-workbench/collection-tree'

export type ComparisonOperatorState = 'equals' | 'notEquals' | 'greaterThan' | 'lessThan'

export interface ConditionState {
  left: string
  operator: ComparisonOperatorState
  right: string
}

/** Mock ligado por um bloco `mockStart` (spec 0121): salvo (pelo id) ou
 * avulso (inteiro no flow, editado numa aba do workbench). */
export type MockServerSourceState = { type: 'saved'; serverId: string } | { type: 'inline'; server: MockServerDto }

export type MockCallCountOperatorState = 'equals' | 'atLeast' | 'atMost'

export type VariableAssignmentState = { name: string } & (
  | { operation: 'set'; value: string }
  | { operation: 'increment'; by: number }
)

/** Nodes cuja configuração inteira vive em `data.config` no canvas (spec
 * 0083) — convertidos de/para DTO e duplicados de forma genérica, em vez de
 * um ramo por campo como `block`/`request`/`if`. */
export type SimpleNodeKindState =
  | { kind: 'note'; text: string; width: number; height: number }
  | { kind: 'log'; message: string }
  | { kind: 'display'; template: string }
  | { kind: 'sleep'; durationMs: number }
  | { kind: 'setVariables'; assignments: VariableAssignmentState[] }
  | { kind: 'while'; condition: ConditionState; maxIterations: number }
  | { kind: 'break' }
  | { kind: 'continue' }
  /** Requisição avulsa (spec 0086): a requisição inteira fica no flow, editada
   * numa aba do workbench. */
  | { kind: 'inlineRequest'; request: RequestSummary }
  /** Blocos de mock server (spec 0121): os demais apontam para o bloco
   * `mockStart` que ligou o mock (`startNodeId`). */
  | { kind: 'mockStart'; source: MockServerSourceState }
  | { kind: 'mockStop'; startNodeId: string }
  | { kind: 'mockWaitRequest'; startNodeId: string; routeId: string; timeoutMs: number }
  | { kind: 'mockSetResponse'; startNodeId: string; routeId: string; responseId: string | null }
  | { kind: 'mockAssertCalls'; startNodeId: string; routeId: string; operator: MockCallCountOperatorState; count: number }

export type SimpleNodeKind = SimpleNodeKindState['kind']

const SIMPLE_NODE_KINDS: readonly string[] = [
  'note',
  'log',
  'display',
  'sleep',
  'setVariables',
  'while',
  'break',
  'continue',
  'inlineRequest',
  'mockStart',
  'mockStop',
  'mockWaitRequest',
  'mockSetResponse',
  'mockAssertCalls',
]

/** Blocos de mock server: não entram em flows de carga. */
export type MockNodeKind = 'mockStart' | 'mockStop' | 'mockWaitRequest' | 'mockSetResponse' | 'mockAssertCalls'

export function isSimpleNodeKind(kind: string | undefined): kind is SimpleNodeKind {
  return kind !== undefined && SIMPLE_NODE_KINDS.includes(kind)
}

/** `node` (DTO ou estado) é de um tipo simples — estreita o union inteiro,
 * não só o campo `kind`. */
export function isSimpleNode<T extends { kind: string }>(node: T): node is Extract<T, SimpleNodeKindState> {
  return isSimpleNodeKind(node.kind)
}

/** Só os campos de configuração de um node simples — descarta `id`,
 * posição e o que mais vier junto (DTO ou estado). */
export function simpleNodeConfig(node: SimpleNodeKindState): SimpleNodeKindState {
  switch (node.kind) {
    case 'note':
      return { kind: 'note', text: node.text, width: node.width, height: node.height }
    case 'log':
      return { kind: 'log', message: node.message }
    case 'display':
      return { kind: 'display', template: node.template }
    case 'sleep':
      return { kind: 'sleep', durationMs: node.durationMs }
    case 'setVariables':
      return { kind: 'setVariables', assignments: node.assignments }
    case 'while':
      return { kind: 'while', condition: node.condition, maxIterations: node.maxIterations }
    case 'break':
      return { kind: 'break' }
    case 'continue':
      return { kind: 'continue' }
    case 'inlineRequest':
      return { kind: 'inlineRequest', request: node.request }
    case 'mockStart':
      return { kind: 'mockStart', source: node.source }
    case 'mockStop':
      return { kind: 'mockStop', startNodeId: node.startNodeId }
    case 'mockWaitRequest':
      return { kind: 'mockWaitRequest', startNodeId: node.startNodeId, routeId: node.routeId, timeoutMs: node.timeoutMs }
    case 'mockSetResponse':
      return { kind: 'mockSetResponse', startNodeId: node.startNodeId, routeId: node.routeId, responseId: node.responseId }
    case 'mockAssertCalls':
      return { kind: 'mockAssertCalls', startNodeId: node.startNodeId, routeId: node.routeId, operator: node.operator, count: node.count }
  }
}

export type FlowNodeKindState =
  | { kind: 'start' }
  | { kind: 'block'; label: string }
  | { kind: 'request'; requestId: string }
  | { kind: 'if'; condition: ConditionState }
  | { kind: 'load'; loadKind: LoadNodeKindState; label: string; config: string }
  | SimpleNodeKindState

export type FlowExecutionKindState = 'standard' | 'load'

export type LoadNodeKindState =
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

export type FlowNodeState = FlowNodeKindState & {
  id: string
  position: { x: number; y: number }
}

export type IfBranchHandle = 'true' | 'false'
export type RequestOutcomeHandle = 'success' | 'failure'
/** Saídas de um `while`: `loop` leva ao corpo, `done` segue depois do loop. */
export type WhileHandle = 'loop' | 'done'
export type LoadScenarioHandle = 'iteration' | 'done'
export type LoadThresholdHandle = 'passed' | 'failed'
export type LoadBodyHandle = 'body' | 'done'
export type FlowSourceHandle = IfBranchHandle | RequestOutcomeHandle | WhileHandle | LoadScenarioHandle | LoadThresholdHandle | LoadBodyHandle

const FLOW_SOURCE_HANDLES: readonly string[] = ['true', 'false', 'success', 'failure', 'loop', 'done', 'iteration', 'passed', 'failed', 'body']

export function isFlowSourceHandle(value: string | null | undefined): value is FlowSourceHandle {
  return value != null && FLOW_SOURCE_HANDLES.includes(value)
}

export interface FlowEdgeState {
  id: string
  sourceNodeId: string
  targetNodeId: string
  /** `undefined` para toda edge saindo de um node de saída única; `"true"`/
   * `"false"` para as saídas de um node `if` (e dos blocos de mock
   * `mockWaitRequest`/`mockAssertCalls`), `"success"`/`"failure"` para
   * as de um node `request` e `"loop"`/`"done"` para as de um `while`. */
  sourceHandle?: FlowSourceHandle
}

export interface FlowState {
  id: string
  name: string
  executionKind: FlowExecutionKindState
  nodes: FlowNodeState[]
  edges: FlowEdgeState[]
  createdAtMs: number
  updatedAtMs: number
}
