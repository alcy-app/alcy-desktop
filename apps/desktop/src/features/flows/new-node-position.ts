import { FLOW_GEOMETRY as G, flowNodeSize, snapFlowCoordinate } from './flow-geometry'

interface PositionedNode {
  type?: string
  width?: number
  height?: number
  position: { x: number; y: number }
  measured?: { width?: number; height?: number }
}

/** Keep toolbar-created nodes clear of existing cards without moving an existing layout. */
export function availableNodePosition(position: { x: number; y: number }, nodes: PositionedNode[], size: { width: number; height: number } = flowNodeSize('request', 2)) {
  const next = { x: snapFlowCoordinate(position.x), y: snapFlowCoordinate(position.y) }
  const nearby = nodes.filter((node) => node.position.x < next.x + size.width + G.rowGap && node.position.x + (node.measured?.width ?? node.width ?? flowNodeSize(node.type ?? 'request', 2).width) + G.rowGap > next.x).sort((a, b) => a.position.y - b.position.y)
  for (const node of nearby) {
    if (next.y + size.height + G.rowGap <= node.position.y) break
    const bottom = node.position.y + (node.measured?.height ?? node.height ?? flowNodeSize(node.type ?? 'request', 2).height) + G.rowGap
    if (next.y < bottom) next.y = Math.ceil(bottom / G.grid) * G.grid
  }
  return next
}
