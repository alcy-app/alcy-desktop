import type { Node } from '@xyflow/react'
import type { EnvironmentVariableDto } from '../../bindings/list-environments'
import type { TranslationKey } from '../../shared/i18n/translations'
import { emptyRequestContent } from '../request-workbench/collection-tree'
import type { RequestSummary } from '../request-workbench/collection-tree'
import type {
  ComparisonOperatorState,
  ConditionState,
  SimpleNodeKind,
  SimpleNodeKindState,
} from './flows.types'
import type { MockStartInfo } from './mock-nodes'
import type { RunLogNodeInfo } from './RunLogPanel'
import type { NodeRunStatus } from './use-flow-run'

/** Dados de um node simples no canvas (spec 0083): a configuração inteira em
 * `config`, mais o que o canvas injeta a cada render (status do run e ações). */
export interface SimpleNodeData extends Record<string, unknown> {
  config: SimpleNodeKindState
  runStatus: NodeRunStatus
  onOpenSettings: () => void
  onDelete: () => void
  onDuplicate: () => void
  /** Edição direta no node (texto da anotação). */
  onConfigChange: (config: SimpleNodeKindState) => void
  /** Requisição avulsa: abre a requisição numa aba do workbench. */
  onEditRequest?: () => void
  /** Requisição avulsa: descreve as variáveis da URL no preview. */
  environmentVariables?: EnvironmentVariableDto[]
  /** Blocos de mock (spec 0121): o mock do próprio "Ligar mock", ou o do
   * bloco "Ligar mock" para onde os demais apontam. */
  mockStart?: MockStartInfo | null
  /** "Ligar mock" avulso: abre o mock numa aba do workbench. */
  onEditMockServer?: () => void
  visited?: boolean
  readOnly?: boolean
}

export type SimpleFlowNodeType = Node<SimpleNodeData, SimpleNodeKind>

/** Símbolo exibido no node para o operador de uma condição (`if`/`while`). */
export const CONDITION_OPERATOR_SYMBOL: Record<ComparisonOperatorState, string> = {
  equals: '==',
  notEquals: '!=',
  greaterThan: '>',
  lessThan: '<',
}

/** Condição de um `while` recém-criado — contador é o uso mais comum. */
const DEFAULT_WHILE_CONDITION: ConditionState = { left: '', operator: 'lessThan', right: '' }
const DEFAULT_WHILE_MAX_ITERATIONS = 100

/** Espera inicial de um bloco "Aguardar chamada". */
export const DEFAULT_MOCK_WAIT_TIMEOUT_MS = 30_000

/** Tamanho inicial de uma anotação nova. */
export const DEFAULT_NOTE_SIZE = { width: 260, height: 140 }

/** Configuração de um node simples recém-criado pela paleta. */
/** Requisição avulsa fica de fora: precisa de um nome traduzido (ver `newInlineRequest`). */
export function defaultSimpleNodeConfig(kind: Exclude<SimpleNodeKind, 'inlineRequest'>): SimpleNodeKindState {
  switch (kind) {
    case 'note':
      return { kind: 'note', text: '', ...DEFAULT_NOTE_SIZE }
    case 'log':
      return { kind: 'log', message: '' }
    case 'display':
      return { kind: 'display', template: '' }
    case 'sleep':
      return { kind: 'sleep', durationMs: 1000 }
    case 'setVariables':
      return { kind: 'setVariables', assignments: [] }
    case 'while':
      return { kind: 'while', condition: DEFAULT_WHILE_CONDITION, maxIterations: DEFAULT_WHILE_MAX_ITERATIONS }
    case 'break':
      return { kind: 'break' }
    case 'continue':
      return { kind: 'continue' }
    case 'mockStart':
      return { kind: 'mockStart', source: { type: 'saved', serverId: '' } }
    case 'mockStop':
      return { kind: 'mockStop', startNodeId: '' }
    case 'mockWaitRequest':
      return { kind: 'mockWaitRequest', startNodeId: '', routeId: '', timeoutMs: DEFAULT_MOCK_WAIT_TIMEOUT_MS }
    case 'mockSetResponse':
      return { kind: 'mockSetResponse', startNodeId: '', routeId: '', responseId: null }
    case 'mockAssertCalls':
      return { kind: 'mockAssertCalls', startNodeId: '', routeId: '', operator: 'equals', count: 1 }
  }
}

/** Node simples pronto para o canvas, com ações vazias — o canvas as
 * substitui a cada render. A anotação carrega o próprio tamanho, que o
 * `NodeResizer` do xyflow passa a controlar. */
export function simpleFlowNode(id: string, position: { x: number; y: number }, config: SimpleNodeKindState): SimpleFlowNodeType {
  const noop = () => {}
  return {
    id,
    type: config.kind,
    position,
    ...(config.kind === 'note' ? { width: config.width, height: config.height } : {}),
    data: {
      config,
      runStatus: { status: 'idle' },
      onOpenSettings: noop,
      onDelete: noop,
      onDuplicate: noop,
      onConfigChange: noop,
    },
  }
}

/** Configuração atual de um node simples do canvas — para a anotação, o
 * tamanho vem do próprio node (redimensionado pelo usuário). */
export function configOfSimpleNode(node: SimpleFlowNodeType): SimpleNodeKindState {
  const { config } = node.data
  if (config.kind !== 'note') return config
  return { ...config, width: node.width ?? config.width, height: node.height ?? config.height }
}

export const SIMPLE_NODE_LABEL_KEY: Record<SimpleNodeKind, TranslationKey> = {
  note: 'flows.canvas.newNoteLabel',
  log: 'flows.canvas.newLogLabel',
  display: 'flows.canvas.newDisplayLabel',
  sleep: 'flows.canvas.newSleepLabel',
  setVariables: 'flows.canvas.newSetVariablesLabel',
  while: 'flows.canvas.newWhileLabel',
  break: 'flows.canvas.newBreakLabel',
  continue: 'flows.canvas.newContinueLabel',
  inlineRequest: 'flows.canvas.newInlineRequestLabel',
  mockStart: 'flows.canvas.newMockStartLabel',
  mockStop: 'flows.canvas.newMockStopLabel',
  mockWaitRequest: 'flows.canvas.newMockWaitRequestLabel',
  mockSetResponse: 'flows.canvas.newMockSetResponseLabel',
  mockAssertCalls: 'flows.canvas.newMockAssertCallsLabel',
}

/** Requisição avulsa recém-criada: REST em branco, com um nome (o backend
 * exige nome não vazio). */
export function newInlineRequest(name: string): SimpleNodeKindState {
  return { kind: 'inlineRequest', request: { id: crypto.randomUUID(), name, protocol: 'rest', content: emptyRequestContent('rest') } }
}

/** `MÉTODO url` de uma requisição, como o log e o node mostram. */
export function describeRequest(request: RequestSummary): string {
  const method = request.protocol === 'graphql' ? 'GraphQL' : request.content.method.toUpperCase()
  return `${method} ${request.content.endpointUrl}`
}

/** Espera exibida no node e no log: ms abaixo de 1 s, segundos acima. */
export function formatSleepDuration(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs} ms` : `${durationMs / 1000} s`
}

const MAX_LOG_LABEL_CHARS = 40

/** Como o log do run nomeia um node simples: o conteúdo configurado (curto)
 * quando há, senão o nome do tipo. */
export function simpleNodeLogInfo(config: SimpleNodeKindState, t: (key: TranslationKey) => string): RunLogNodeInfo {
  const kindLabel = t(SIMPLE_NODE_LABEL_KEY[config.kind])
  if (config.kind === 'inlineRequest') {
    return { label: config.request.name, kindLabel, request: describeRequest(config.request) }
  }
  const summary =
    config.kind === 'log'
      ? config.message
      : config.kind === 'display'
        ? config.template
        : config.kind === 'sleep'
          ? formatSleepDuration(config.durationMs)
          : config.kind === 'mockStart' && config.source.type === 'inline'
            ? config.source.server.name
            : ''
  const label = summary.length > MAX_LOG_LABEL_CHARS ? `${summary.slice(0, MAX_LOG_LABEL_CHARS)}…` : summary
  return { label: label || kindLabel, kindLabel, ...(config.kind === 'mockWaitRequest' ? { capturesRequest: true } : {}) }
}
