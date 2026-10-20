import type { NodeProps } from '@xyflow/react'
import type { ReactNode } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { FlowNodeCard } from './FlowNodeCard'
import { formatSleepDuration } from './simple-node-types'
import type { SimpleFlowNodeType, SimpleNodeData } from './simple-node-types'
import { DisplayFormatSelect } from './DisplayFormatSelect'
import { DisplayOutput } from './DisplayOutput'
import { DisplayViewport } from './DisplayViewport'
import { FlowDisplayIcon } from './FlowDisplayIcon'

/** Shared card for single-output action nodes (spec 0083). */
function ActionCard({ data, children }: { data: SimpleNodeData; children: ReactNode }) {
  return (
    <FlowNodeCard
      kind={data.config.kind}
      headerControls={data.config.kind === 'display' ? <DisplayFormatSelect value={data.displayFormat ?? 'auto'} onChange={data.onDisplayFormatChange} /> : undefined}
      runStatus={data.runStatus}
      visited={data.visited}
      readOnly={data.readOnly}
      onOpenSettings={data.onOpenSettings}
      onDuplicate={data.onDuplicate}
      onDelete={data.onDelete}
    >
      {children}
    </FlowNodeCard>
  )
}

export function LogNode({ data }: NodeProps<SimpleFlowNodeType>) {
  const { t } = useLanguage()
  if (data.config.kind !== 'log') return null
  const { message } = data.config
  return (
    <ActionCard data={data}>
      {message ? (
        <code className="flow-node-code-block" title={message.slice(0, 240)}>
          {message.slice(0, 160)}
        </code>
      ) : (
        <span className="flow-node-placeholder">{t('flows.canvas.logMessageEmpty')}</span>
      )}
    </ActionCard>
  )
}

/** The Display viewport scrolls through redacted values and bounded response pages. */
export function DisplayNode({ data }: NodeProps<SimpleFlowNodeType>) {
  const { t } = useLanguage()
  if (data.config.kind !== 'display') return null
  return <ActionCard data={data}><DisplayViewport>
    {data.runStatus.status === 'completed' ? <DisplayOutput value={data.runStatus.message ?? t('common.empty')} format={data.displayFormat ?? 'auto'} source={data.displaySource} compact /> : <div className="flow-display-empty"><FlowDisplayIcon size={24} /><span>{t('flows.canvas.displayEmptyValue')}</span></div>}
  </DisplayViewport></ActionCard>
}

export function SleepNode({ data }: NodeProps<SimpleFlowNodeType>) {
  if (data.config.kind !== 'sleep') return null
  return (
    <ActionCard data={data}>
      <span className="flow-node-duration">{formatSleepDuration(data.config.durationMs)}</span>
    </ActionCard>
  )
}

export function SetVariablesNode({ data }: NodeProps<SimpleFlowNodeType>) {
  const { t } = useLanguage()
  if (data.config.kind !== 'setVariables') return null
  const { assignments } = data.config
  return <ActionCard data={data}>{assignments.length === 0 ? <span className="flow-node-placeholder">{t('flows.canvas.setVariablesEmpty')}</span> : <span>{t('flows.canvas.variableSummary', { count: assignments.length })} · {assignments.slice(0, 3).map((assignment) => assignment.name || '—').join(', ')}</span>}</ActionCard>
}
