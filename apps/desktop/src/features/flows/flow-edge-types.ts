import type { Edge } from '@xyflow/react'

export type FlowEdgeData = { onDelete: () => void; active: boolean; traversed: boolean; hovered: boolean }

export type FlowEdgeType = Edge<FlowEdgeData>
