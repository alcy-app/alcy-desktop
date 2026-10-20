import type { NodeProps } from '@xyflow/react'
import { useLanguage } from '../../shared/i18n/use-language'
import { ConditionView } from './ConditionView'
import { FlowNodeCard } from './FlowNodeCard'
import type { SimpleFlowNodeType } from './simple-node-types'
import { QuickNodeEdit } from './QuickNodeEdit'

/** While nodes repeat their loop output while the condition holds; the done output continues afterward (spec 0084, ADR 0033). */
export function WhileNode({ data, id }: NodeProps<SimpleFlowNodeType>) {
  const { t } = useLanguage()
  const { config } = data
  if (config.kind !== 'while') return null

  return (
    <FlowNodeCard
      kind="while"
      runStatus={data.runStatus}
      visited={data.visited}
      readOnly={data.readOnly}
      onOpenSettings={data.onOpenSettings}
      headerActions={!data.readOnly && <QuickNodeEdit nodeId={id} config={config} onChange={(next) => { if (next.kind !== 'if') data.onConfigChange(next) }} />}
      onDuplicate={data.onDuplicate}
      onDelete={data.onDelete}
      outputs={[
        { id: 'loop', label: t('flows.canvas.whileLoopLabel'), variant: 'loop' },
        { id: 'done', label: t('flows.canvas.whileDoneLabel'), variant: 'neutral' },
      ]}
    >
      <ConditionView condition={config.condition} />
      <span className="flow-node-caption">{t('flows.canvas.whileMaxIterations', { max: config.maxIterations })}</span>
    </FlowNodeCard>
  )
}
