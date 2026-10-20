import type { NodeProps } from '@xyflow/react'
import type { ReactNode } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { FlowNodeCard } from './FlowNodeCard'
import { formatSleepDuration } from './simple-node-types'
import type { SimpleFlowNodeType, SimpleNodeData } from './simple-node-types'
import { QuickNodeEdit } from './QuickNodeEdit'
import { DisplayValue } from './DisplayValue'

const MAX_ASSIGNMENTS_SHOWN = 4

/** Shared card for single-output action nodes (spec 0083). */
function ActionCard({ data, children, nodeId }: { data: SimpleNodeData; children: ReactNode; nodeId: string }) {
  return (
    <FlowNodeCard
      kind={data.config.kind}
      runStatus={data.runStatus}
      visited={data.visited}
      readOnly={data.readOnly}
      onOpenSettings={data.onOpenSettings}
      headerActions={!data.readOnly && <QuickNodeEdit nodeId={nodeId} config={data.config} onChange={(config) => { if (config.kind !== 'if') data.onConfigChange(config) }} />}
      onDuplicate={data.onDuplicate}
      onDelete={data.onDelete}
    >
      {children}
    </FlowNodeCard>
  )
}

export function LogNode({ data, id }: NodeProps<SimpleFlowNodeType>) {
  const { t } = useLanguage()
  if (data.config.kind !== 'log') return null
  const { message } = data.config
  return (
    <ActionCard data={data} nodeId={id}>
      {message ? (
        <code className="flow-node-code-block" title={message}>
          {message}
        </code>
      ) : (
        <span className="flow-node-placeholder">{t('flows.canvas.logMessageEmpty')}</span>
      )}
    </ActionCard>
  )
}

const DISPLAY_VISIBLE_LINES = 10
const DISPLAY_VISIBLE_CHARS = 400

/** Estimate whether the value exceeds the non-scrolling card preview without measuring the DOM. */
function isLongDisplayValue(message: string | null): boolean {
  if (!message) return false
  return message.split('\n').length > DISPLAY_VISIBLE_LINES || message.length > DISPLAY_VISIBLE_CHARS
}

/** Show the last backend-redacted result. Keep the scaled canvas free of scrolling areas to avoid WebKitGTK rasterization blur; inspect full available results in the inspector. */
export function DisplayNode({ data, id }: NodeProps<SimpleFlowNodeType>) {
  const { t } = useLanguage()
  if (data.config.kind !== 'display') return null
  const { runStatus } = data
  const { template } = data.config
  return (
    <ActionCard data={data} nodeId={id}>
      {template ? (
        <code className="flow-node-inline-code" title={template}>
          {template}
        </code>
      ) : (
        <span className="flow-node-placeholder">{t('flows.canvas.displayTemplateEmpty')}</span>
      )}
      {runStatus.status === 'completed' ? (
        <>
          <DisplayValue value={runStatus.message ?? ''} format={data.displayFormat} compact />
          {isLongDisplayValue(runStatus.message) && <span className="flow-node-caption">{t('flows.canvas.displayTruncatedHint')}</span>}
        </>
      ) : (
        runStatus.status !== 'failed' && <span className="flow-node-display-placeholder">{t('flows.canvas.displayEmptyValue')}</span>
      )}
    </ActionCard>
  )
}

export function SleepNode({ data, id }: NodeProps<SimpleFlowNodeType>) {
  if (data.config.kind !== 'sleep') return null
  return (
    <ActionCard data={data} nodeId={id}>
      <span className="flow-node-duration">{formatSleepDuration(data.config.durationMs)}</span>
    </ActionCard>
  )
}

export function SetVariablesNode({ data, id }: NodeProps<SimpleFlowNodeType>) {
  const { t } = useLanguage()
  if (data.config.kind !== 'setVariables') return null
  const { assignments } = data.config
  const hidden = assignments.length - MAX_ASSIGNMENTS_SHOWN
  return (
    <ActionCard data={data} nodeId={id}>
      {assignments.length === 0 ? (
        <span className="flow-node-placeholder">{t('flows.canvas.setVariablesEmpty')}</span>
      ) : (
        <>
          <dl className="flow-node-assignments">
            {assignments.slice(0, MAX_ASSIGNMENTS_SHOWN).map((assignment, index) => {
              const value = assignment.operation === 'set' ? assignment.value : String(assignment.by)
              return (
                <div key={index} className="flow-node-assignment">
                  <dt className="flow-node-assignment-name" title={assignment.name}>
                    {assignment.name || '—'}
                  </dt>
                  <dd className="flow-node-assignment-value" title={value}>
                    <span className="flow-node-assignment-operator">{assignment.operation === 'set' ? '=' : '+='}</span>
                    {value}
                  </dd>
                </div>
              )
            })}
          </dl>
          {hidden > 0 && <span className="flow-node-caption">+{hidden}</span>}
        </>
      )}
    </ActionCard>
  )
}
