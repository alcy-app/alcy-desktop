import type { NodeProps } from '@xyflow/react'
import { FlowNodeCard } from './FlowNodeCard'
import type { SimpleFlowNodeType } from './simple-node-types'

/** `Break`/`Continue` (spec 0085): só entrada, sem saídas nem configuração —
 * encerram o loop ou a iteração do `While` mais interno que os contém. */
function LoopControl({ data, kind }: { data: SimpleFlowNodeType['data']; kind: 'break' | 'continue' }) {
  return (
    <FlowNodeCard
      kind={kind}
      compact
      outputs="none"
      runStatus={data.runStatus}
      visited={data.visited}
      readOnly={data.readOnly}
      onDuplicate={data.onDuplicate}
      onDelete={data.onDelete}
    />
  )
}

export function BreakNode({ data }: NodeProps<SimpleFlowNodeType>) {
  return <LoopControl data={data} kind="break" />
}

export function ContinueNode({ data }: NodeProps<SimpleFlowNodeType>) {
  return <LoopControl data={data} kind="continue" />
}
