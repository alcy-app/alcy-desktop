import type { Node } from '@xyflow/react'
import type { EnvironmentVariableDto } from '../../bindings/list-environments'
import type { TranslationKey } from '../../shared/i18n/translations'
import { emptyRequestContent, requestMethodLabel } from '../request-workbench/collection-tree'
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
import type { DisplayFormat } from './display-format'
import type { DisplayBodySource } from './display-output-source'

/** Canonical configuration plus transient execution and interaction data for simple canvas nodes (spec 0083). */
export interface SimpleNodeData extends Record<string, unknown> {
  displayFormat?: DisplayFormat
  onDisplayFormatChange?: (format: DisplayFormat) => void
  displaySource?: DisplayBodySource
  config: SimpleNodeKindState
  runStatus: NodeRunStatus
  onOpenSettings: () => void
  onDelete: () => void
  onDuplicate: () => void
  /** Direct node edits, including note text. */
  onConfigChange: (config: SimpleNodeKindState) => void
  /** Open an inline request in the inspector or workbench fallback. */
  onEditRequest?: () => void
  /** Variables used to describe templates in inline request URL previews. */
  environmentVariables?: EnvironmentVariableDto[]
  /** The mock started by this node or referenced by its Start mock node (spec 0121). */
  mockStart?: MockStartInfo | null
  /** Open the inline Start mock in a workbench tab. */
  onEditMockServer?: () => void
  visited?: boolean
  readOnly?: boolean
}

export type SimpleFlowNodeType = Node<SimpleNodeData, SimpleNodeKind>

/** Display symbol for an If or While comparison operator. */
export const CONDITION_OPERATOR_SYMBOL: Record<ComparisonOperatorState, string> = {
  equals: '==',
  notEquals: '!=',
  greaterThan: '>',
  lessThan: '<',
}

/** Default While condition; a counter is the common starting point. */
const DEFAULT_WHILE_CONDITION: ConditionState = { left: '', operator: 'lessThan', right: '' }
const DEFAULT_WHILE_MAX_ITERATIONS = 100

/** Initial timeout for a Wait for request block. */
export const DEFAULT_MOCK_WAIT_TIMEOUT_MS = 30_000

/** Default dimensions for a new note. */
export const DEFAULT_NOTE_SIZE = { width: 260, height: 140 }

/** Initial configuration for a simple node selected from the palette. */
/** Inline requests need a translated nonempty name; see newInlineRequest. */
export function defaultSimpleNodeConfig(kind: Exclude<SimpleNodeKind, 'inlineRequest'>): SimpleNodeKindState {
  switch (kind) {
    case 'humanAction':
      return { kind: 'humanAction', form: { title: '', description: '', sections: [] } }
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

/** Initial canvas data with placeholder actions replaced by the canvas; React Flow's NodeResizer owns note dimensions. */
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

/** Read current canonical configuration, taking resized note dimensions from the node itself. */
export function configOfSimpleNode(node: SimpleFlowNodeType): SimpleNodeKindState {
  const { config } = node.data
  if (config.kind !== 'note') return config
  return { ...config, width: node.width ?? config.width, height: node.height ?? config.height }
}

export const SIMPLE_NODE_LABEL_KEY: Record<SimpleNodeKind, TranslationKey> = {
  humanAction: 'flows.forms.humanAction',
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

/** Create a blank REST request with the nonempty name required by the backend. */
export function newInlineRequest(name: string): SimpleNodeKindState {
  return { kind: 'inlineRequest', request: { id: crypto.randomUUID(), name, protocol: 'rest', content: emptyRequestContent('rest') } }
}

/** METHOD URL label shared by request cards and the execution log. */
export function describeRequest(request: RequestSummary): string {
  return `${requestMethodLabel(request)} ${request.content.endpointUrl}`
}

/** Display milliseconds below one second, otherwise seconds. */
export function formatSleepDuration(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs} ms` : `${durationMs / 1000} s`
}

const MAX_LOG_LABEL_CHARS = 40

/** Use a compact configuration summary as the log label, falling back to the node kind. */
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
