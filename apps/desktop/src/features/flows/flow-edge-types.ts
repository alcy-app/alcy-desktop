import type { Edge } from '@xyflow/react'
import type { FlowEdgeRoute } from './flow-layout'

export type FlowEdgeData = { onDelete: () => void; active: boolean; traversed: boolean; hovered: boolean } & Partial<FlowEdgeRoute>

export type FlowEdgeType = Edge<FlowEdgeData>
