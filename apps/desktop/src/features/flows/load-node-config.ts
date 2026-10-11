import type { TranslationKey } from '../../shared/i18n/translations'
import type { LoadNodeKindState } from './flows.types'

export interface LoadNodeDefinition {
  labelKey: TranslationKey
  descriptionKey: TranslationKey
  config: Record<string, unknown>
  outputs: 'single' | 'none' | readonly ('iteration' | 'done' | 'success' | 'body')[]
}

export const EXECUTABLE_LOAD_NODE_KINDS: readonly LoadNodeKindState[] = [
  'scenario', 'request', 'script', 'repeat', 'forEach', 'oncePerVu', 'timeBox', 'select', 'group',
  'timer', 'dataset', 'configureSession', 'extract', 'check', 'metric', 'threshold',
]

export const LOAD_NODE_DEFINITIONS: Record<LoadNodeKindState, LoadNodeDefinition> = {
  scenario: { labelKey: 'flows.loadNode.scenario.label', descriptionKey: 'flows.loadNode.scenario.description', config: { executor: 'sharedIterations', vus: 1, iterations: 1 }, outputs: ['iteration', 'done'] },
  request: { labelKey: 'flows.loadNode.request.label', descriptionKey: 'flows.loadNode.request.description', config: { method: 'GET', url: 'https://example.test/', body: '', headers: [], redirectPolicy: 'follow', tags: {} }, outputs: ['success'] },
  script: { labelKey: 'flows.loadNode.script.label', descriptionKey: 'flows.loadNode.script.description', config: { phase: 'preRequest', code: '' }, outputs: 'single' },
  repeat: { labelKey: 'flows.loadNode.repeat.label', descriptionKey: 'flows.loadNode.repeat.description', config: { count: 1 }, outputs: ['body', 'done'] },
  forEach: { labelKey: 'flows.loadNode.forEach.label', descriptionKey: 'flows.loadNode.forEach.description', config: { variable: 'item', items: ['value'] }, outputs: ['body', 'done'] },
  oncePerVu: { labelKey: 'flows.loadNode.oncePerVu.label', descriptionKey: 'flows.loadNode.oncePerVu.description', config: {}, outputs: ['body', 'done'] },
  timeBox: { labelKey: 'flows.loadNode.timeBox.label', descriptionKey: 'flows.loadNode.timeBox.description', config: { durationMs: 1000 }, outputs: ['body', 'done'] },
  select: { labelKey: 'flows.loadNode.select.label', descriptionKey: 'flows.loadNode.select.description', config: { variable: 'item', equals: 'value' }, outputs: ['body', 'done'] },
  group: { labelKey: 'flows.loadNode.group.label', descriptionKey: 'flows.loadNode.group.description', config: { name: 'group', tags: {}, includeTimers: true, emitParent: true }, outputs: ['body', 'done'] },
  timer: { labelKey: 'flows.loadNode.timer.label', descriptionKey: 'flows.loadNode.timer.description', config: { kind: 'fixed', durationMs: 1000 }, outputs: 'single' },
  dataset: { labelKey: 'flows.loadNode.dataset.label', descriptionKey: 'flows.loadNode.dataset.description', config: { rows: [{ value: 'value' }], recycle: true }, outputs: 'single' },
  configureSession: { labelKey: 'flows.loadNode.configureSession.label', descriptionKey: 'flows.loadNode.configureSession.description', config: { headers: [], variables: {}, cookiesEnabled: true }, outputs: 'single' },
  extract: { labelKey: 'flows.loadNode.extract.label', descriptionKey: 'flows.loadNode.extract.description', config: { name: 'value', jsonPointer: '' }, outputs: 'single' },
  check: { labelKey: 'flows.loadNode.check.label', descriptionKey: 'flows.loadNode.check.description', config: { name: 'status is 200', status: 200 }, outputs: 'single' },
  metric: { labelKey: 'flows.loadNode.metric.label', descriptionKey: 'flows.loadNode.metric.description', config: { name: 'events', kind: 'counter', value: 1, tags: {} }, outputs: 'single' },
  threshold: { labelKey: 'flows.loadNode.threshold.label', descriptionKey: 'flows.loadNode.threshold.description', config: { metric: 'http_req_failed', tags: {}, statistic: 'rate', comparison: 'lessThan', target: 0.01 }, outputs: 'none' },
}

export function defaultLoadNodeConfig(kind: LoadNodeKindState): string {
  return JSON.stringify(LOAD_NODE_DEFINITIONS[kind].config, null, 2)
}

export function defaultLoadNodeLabel(kind: LoadNodeKindState, translate: (key: TranslationKey) => string): string {
  return translate(LOAD_NODE_DEFINITIONS[kind].labelKey)
}
