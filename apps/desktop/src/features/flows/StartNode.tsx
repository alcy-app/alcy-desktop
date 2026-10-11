import type { Node, NodeProps } from '@xyflow/react'
import { FlowNodeCard } from './FlowNodeCard'

export type StartNodeType = Node<{ visited?: boolean }, 'start'>

export function StartNode({ data }: NodeProps<StartNodeType>) {
  return <FlowNodeCard kind="start" compact hasInput={false} visited={data.visited} />
}
