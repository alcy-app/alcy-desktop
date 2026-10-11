import type { NodeProps } from '@xyflow/react'
import { useLanguage } from '../../shared/i18n/use-language'
import { ConditionView } from './ConditionView'
import { FlowNodeCard } from './FlowNodeCard'
import type { SimpleFlowNodeType } from './simple-node-types'

/** Loop (spec 0084, ADR 0033): tudo o que sai pela saída `loop` é o corpo,
 * repetido enquanto a condição for verdadeira; a saída `done` segue depois.
 * Mesma estrutura de duas saídas nomeadas do `IfNode`. */
export function WhileNode({ data }: NodeProps<SimpleFlowNodeType>) {
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
