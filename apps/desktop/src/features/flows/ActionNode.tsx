import type { NodeProps } from '@xyflow/react'
import type { ReactNode } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { FlowNodeCard } from './FlowNodeCard'
import { formatSleepDuration } from './simple-node-types'
import type { SimpleFlowNodeType, SimpleNodeData } from './simple-node-types'

const MAX_ASSIGNMENTS_SHOWN = 4

/** Cartão comum dos nodes de saída única da spec 0083 (Log, Display, Sleep,
 * Variáveis locais). */
function ActionCard({ data, children }: { data: SimpleNodeData; children: ReactNode }) {
  return (
    <FlowNodeCard
      kind={data.config.kind}
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

/** O valor não cabe na área do node (cortada, sem rolagem) — estimativa por
 * linhas e tamanho, sem medir o DOM. */
function isLongDisplayValue(message: string | null): boolean {
  if (!message) return false
  return message.split('\n').length > DISPLAY_VISIBLE_LINES || message.length > DISPLAY_VISIBLE_CHARS
}

/** Mostra no próprio node o valor resolvido na última execução (o `message`
 * do evento `nodeCompleted`, já mascarado pelo backend). A área não rola:
 * uma área rolável dentro do canvas faz o WebKitGTK compor o viewport numa
 * camada rasterizada, e todos os nodes ficam borrados no zoom. O valor
 * completo fica no log do run. */
export function DisplayNode({ data }: NodeProps<SimpleFlowNodeType>) {
  const { t } = useLanguage()
  if (data.config.kind !== 'display') return null
  const { runStatus } = data
  const { template } = data.config
  return (
    <ActionCard data={data}>
      {template ? (
        <code className="flow-node-inline-code" title={template}>
          {template}
        </code>
      ) : (
        <span className="flow-node-placeholder">{t('flows.canvas.displayTemplateEmpty')}</span>
      )}
      {runStatus.status === 'completed' ? (
        <>
          <pre className="flow-node-display-value nodrag">{runStatus.message || t('common.empty')}</pre>
          {isLongDisplayValue(runStatus.message) && <span className="flow-node-caption">{t('flows.canvas.displayTruncatedHint')}</span>}
        </>
      ) : (
        runStatus.status !== 'failed' && <span className="flow-node-display-placeholder">{t('flows.canvas.displayEmptyValue')}</span>
      )}
    </ActionCard>
  )
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
  const hidden = assignments.length - MAX_ASSIGNMENTS_SHOWN
  return (
    <ActionCard data={data}>
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
