import type { Node, NodeProps } from '@xyflow/react'
import { FlowNodeCard } from './FlowNodeCard'
import type { NodeOutput } from './FlowNodeCard'
import { LOAD_NODE_DEFINITIONS } from './load-node-config'
import type { LoadNodeKindState } from './flows.types'
import { useLanguage } from '../../shared/i18n/use-language'
import { useMemo } from 'react'
import type { TranslationKey } from '../../shared/i18n/translations'

export type BlockNodeType = Node<
  {
    label: string
    /** Preserve imported load semantics while sharing the card renderer. */
    loadKind?: string
    loadConfig?: string
    onOpenSettings: () => void
    onDelete: () => void
    onDuplicate: () => void
    visited?: boolean
    readOnly?: boolean
  },
  'block'
>

export function BlockNode({ data }: NodeProps<BlockNodeType>) {
  const { t } = useLanguage()
  const definition = data.loadKind ? LOAD_NODE_DEFINITIONS[data.loadKind as LoadNodeKindState] : null
  const settings = useMemo<Record<string, unknown>>(() => {
    if (!data.loadConfig || data.loadConfig.length > 64 * 1024) return {}
    try { const parsed: unknown = JSON.parse(data.loadConfig); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {} } catch { return {} }
  }, [data.loadConfig])
  const summaries: Partial<Record<LoadNodeKindState, [TranslationKey, unknown][]>> = {
    request: [['flows.loadNode.request.url', settings.url]],
    scenario: [['flows.loadNode.scenario.vus', settings.vus ?? settings.preAllocatedVus ?? settings.startVus], ['flows.loadNode.scenario.iterations', settings.iterations ?? settings.iterationsPerVu], ['flows.loadNode.scenario.duration', settings.durationMs]],
    timer: [['flows.loadNode.timer.duration', settings.durationMs], ['flows.loadNode.timer.kind', settings.kind]],
    repeat: [['flows.loadNode.repeat.count', settings.count]],
    forEach: [['flows.loadNode.forEach.variable', settings.variable]],
    select: [['flows.loadNode.forEach.variable', settings.variable]],
    group: [['flows.loadNode.group.name', settings.name]],
    extract: [['flows.loadNode.extract.name', settings.name]],
    check: [['flows.loadNode.check.name', settings.name]],
    metric: [['flows.loadNode.metric.name', settings.name]],
    threshold: [['flows.loadNode.threshold.metric', settings.metric], ['flows.loadNode.threshold.target', settings.target]],
    timeBox: [['flows.loadNode.scenario.duration', settings.durationMs]],
    script: [['flows.loadNode.script.phase', settings.phase]],
  }
  const summary = data.loadKind ? (summaries[data.loadKind as LoadNodeKindState] ?? []).filter(([, value]) => typeof value === 'string' || typeof value === 'number') : []
  let outputs: 'single' | 'none' | NodeOutput[] = 'single'
  if (definition?.outputs === 'single' || definition?.outputs === 'none') {
    outputs = definition.outputs
  } else if (definition) {
    outputs = definition.outputs.map((id) => ({
        id,
        label: id === 'iteration' ? t('flows.canvas.loadIterationLabel') : id === 'body' ? t('flows.canvas.loadBodyLabel') : id === 'success' ? t('flows.canvas.requestSuccessLabel') : t('flows.canvas.whileDoneLabel'),
        variant: id === 'iteration' || id === 'body' ? 'loop' : id === 'success' ? 'positive' : 'neutral',
      }))
  }
  return (
    <FlowNodeCard
      kind={data.loadKind ? 'load' : 'block'}
      title={data.label || undefined}
      subtitle={definition ? t(definition.descriptionKey) : undefined}
      outputs={outputs}
      visited={data.visited}
      readOnly={data.readOnly}
      onOpenSettings={data.onOpenSettings}
      onDuplicate={data.onDuplicate}
      onDelete={data.onDelete}
      titleBadge={data.loadKind === 'request' && typeof settings.method === 'string' ? <span className="flow-node-method">{settings.method}</span> : undefined}
    >
      {summary.length > 0 && <dl className="flow-node-assignments">{summary.map(([label, value]) => <div key={label} className="flow-node-assignment"><dt className="flow-node-assignment-name">{t(label)}</dt><dd className="flow-node-assignment-value" title={String(value)}>{String(value)}</dd></div>)}</dl>}
    </FlowNodeCard>
  )
}
