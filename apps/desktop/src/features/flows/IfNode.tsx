import type { Node, NodeProps } from '@xyflow/react'
import { useLanguage } from '../../shared/i18n/use-language'
import { ConditionView } from './ConditionView'
import type { ConditionState } from './flows.types'
import { FlowNodeCard } from './FlowNodeCard'
import type { NodeRunStatus } from './use-flow-run'

export type IfNodeType = Node<
  {
    condition: ConditionState
    runStatus: NodeRunStatus
    onOpenSettings: () => void
    onConditionChange?: (condition: ConditionState) => void
    onDelete: () => void
    onDuplicate: () => void
    visited?: boolean
    readOnly?: boolean
  },
  'if'
>

/** If nodes expose true/false outputs and preserve the selected branch in edge handles (spec 0047). Conditions are editable in the inspector. */
export function IfNode({ data }: NodeProps<IfNodeType>) {
  const { t } = useLanguage()

  return (
    <FlowNodeCard
      kind="if"
      runStatus={data.runStatus}
      visited={data.visited}
      readOnly={data.readOnly}
      onOpenSettings={data.onOpenSettings}
      onDuplicate={data.onDuplicate}
      onDelete={data.onDelete}
      outputs={[
        { id: 'true', label: t('flows.canvas.ifTrueLabel'), variant: 'positive' },
        { id: 'false', label: t('flows.canvas.ifFalseLabel'), variant: 'neutral' },
      ]}
    >
      <ConditionView condition={data.condition} />
    </FlowNodeCard>
  )
}
