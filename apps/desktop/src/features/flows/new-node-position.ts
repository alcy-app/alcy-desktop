interface PositionedNode {
  position: { x: number; y: number }
  measured?: { width?: number; height?: number }
}

/** Keep toolbar-created nodes clear of existing cards without moving an existing layout. */
export function availableNodePosition(position: { x: number; y: number }, nodes: PositionedNode[]) {
  const next = { ...position }
  const nearby = nodes.filter((node) => node.position.x < next.x + 288 + 32 && node.position.x + (node.measured?.width ?? 288) + 32 > next.x).sort((a, b) => a.position.y - b.position.y)
  for (const node of nearby) {
    if (next.y + 320 + 32 <= node.position.y) break
    const bottom = node.position.y + (node.measured?.height ?? 240) + 32
    if (next.y < bottom) next.y = bottom
  }
  return next
}
