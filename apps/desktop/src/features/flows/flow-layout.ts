import { FLOW_GEOMETRY as G, snapFlowCoordinate as snap } from './flow-geometry'

export interface LayoutNode {
  id: string
  kind: string
  position: { x: number; y: number }
  width: number
  height: number
}
export interface LayoutEdge { source: string; target: string; sourceHandle?: string | null }
export type FlowPositions = Record<string, { x: number; y: number }>
export interface LayoutGraph { nodes: LayoutNode[]; edges: LayoutEdge[] }
export interface FlowEdgeRoute { outsideY: number; sourceLaneX: number; targetLaneX: number }

export function branchOrder(handle?: string | null) {
  return ['false', 'failure', 'done', 'failed'].includes(handle ?? '') ? 1 : 0
}

export function rectanglesOverlap(a: LayoutNode, b: LayoutNode, gap: number = G.rowGap) {
  return a.position.x < b.position.x + b.width + gap && a.position.x + a.width + gap > b.position.x && a.position.y < b.position.y + b.height + gap && a.position.y + a.height + gap > b.position.y
}

/** Iterative Kosaraju avoids recursion limits for long imported chains. */
function components(ids: string[], outgoing: Map<string, string[]>, incoming: Map<string, string[]>) {
  const seen = new Set<string>(), finished: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    const stack: [string, boolean][] = [[id, false]]
    while (stack.length) {
      const [current, exit] = stack.pop()!
      if (exit) { finished.push(current); continue }
      if (seen.has(current)) continue
      seen.add(current)
      stack.push([current, true])
      for (const next of outgoing.get(current) ?? []) if (!seen.has(next)) stack.push([next, false])
    }
  }
  const groups: string[][] = [], membership = new Map<string, number>()
  for (const id of finished.reverse()) {
    if (membership.has(id)) continue
    const index = groups.length, group: string[] = [], stack = [id]
    membership.set(id, index)
    while (stack.length) {
      const current = stack.pop()!
      group.push(current)
      for (const next of incoming.get(current) ?? []) if (!membership.has(next)) { membership.set(next, index); stack.push(next) }
    }
    groups.push(group)
  }
  return { groups, membership }
}

/** Deterministic layered layout. Notes are fixed obstacles; graph semantics never change. */
export function layoutFlowGraph({ nodes, edges }: LayoutGraph): FlowPositions {
  const executable = nodes.filter((node) => node.kind !== 'note').sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id))
  const byId = new Map(executable.map((node) => [node.id, node]))
  const validEdges = edges.filter((edge) => byId.has(edge.source) && byId.has(edge.target)).sort((a, b) => a.source.localeCompare(b.source) || branchOrder(a.sourceHandle) - branchOrder(b.sourceHandle) || a.target.localeCompare(b.target))
  const inEdges = new Map(executable.map((node) => [node.id, [] as LayoutEdge[]]))
  const outEdges = new Map(executable.map((node) => [node.id, [] as LayoutEdge[]]))
  const outgoing = new Map(executable.map((node) => [node.id, [] as string[]]))
  const incoming = new Map(executable.map((node) => [node.id, [] as string[]]))
  for (const edge of validEdges) { outgoing.get(edge.source)!.push(edge.target); incoming.get(edge.target)!.push(edge.source); inEdges.get(edge.target)!.push(edge); outEdges.get(edge.source)!.push(edge) }
  const { groups, membership } = components(executable.map((node) => node.id), outgoing, incoming)
  const next = groups.map(() => new Set<number>()), previous = groups.map(() => new Set<number>())
  for (const edge of validEdges) {
    const a = membership.get(edge.source)!, b = membership.get(edge.target)!
    if (a !== b) { next[a].add(b); previous[b].add(a) }
  }
  const rank = groups.map(() => 0), remaining = previous.map((set) => set.size)
  const queue = groups.map((_, index) => index).filter((index) => remaining[index] === 0)
  for (let cursor = 0; cursor < queue.length; cursor++) for (const child of next[queue[cursor]]) {
    rank[child] = Math.max(rank[child], rank[queue[cursor]] + 1)
    if (--remaining[child] === 0) queue.push(child)
  }
  const weakGroups: string[][] = [], visited = new Set<string>()
  const seeds = [...executable].sort((a, b) => Number(b.kind === 'start') - Number(a.kind === 'start'))
  for (const seed of seeds) {
    if (visited.has(seed.id)) continue
    const group = [seed.id]; visited.add(seed.id)
    for (let cursor = 0; cursor < group.length; cursor++) for (const neighbor of [...outgoing.get(group[cursor])!, ...incoming.get(group[cursor])!]) {
      if (!visited.has(neighbor)) { visited.add(neighbor); group.push(neighbor) }
    }
    weakGroups.push(group)
  }
  const positions: FlowPositions = Object.create(null)
  for (const node of nodes) if (node.kind === 'note') positions[node.id] = { ...node.position }
  const occupied = nodes.filter((node) => node.kind === 'note').map((node) => ({ ...node }))
  const originX = executable.length ? snap(executable.reduce((value, node) => Math.min(value, node.position.x), Infinity)) : 0
  let top = executable.length ? snap(executable.reduce((value, node) => Math.min(value, node.position.y), Infinity)) : 0
  for (const ids of weakGroups) {
    const layers = new Map<number, string[]>()
    for (const id of ids) { const column = rank[membership.get(id)!]; layers.set(column, [...(layers.get(column) ?? []), id]) }
    const columns = [...layers.keys()].sort((a, b) => a - b)
    const order = new Map<string, number>()
    for (const list of layers.values()) list.forEach((id, index) => order.set(id, index))
    // Two forward/backward barycentric sweeps keep branches and convergences legible.
    for (let pass = 0; pass < 2; pass++) for (const forward of [true, false]) for (const column of forward ? columns : [...columns].reverse()) {
      const list = layers.get(column)!
      const score = (id: string) => {
        const links = (forward ? inEdges : outEdges).get(id)!
        return links.length ? links.reduce((sum, edge) => sum + (order.get(forward ? edge.source : edge.target) ?? 0) + branchOrder(edge.sourceHandle) * 0.25, 0) / links.length : order.get(id) ?? 0
      }
      const scores = new Map(list.map((id) => [id, score(id)]))
      list.sort((a, b) => scores.get(a)! - scores.get(b)! || order.get(a)! - order.get(b)! || a.localeCompare(b))
      list.forEach((id, index) => order.set(id, index))
    }
    let x = originX, bottom = top
    for (const column of columns) {
      const list = layers.get(column)!
      let y = top
      for (const id of list) {
        const node = byId.get(id)!
        const placed = { ...node, position: { x: snap(x), y: Math.ceil(y / G.grid) * G.grid } }
        // Moving downward reaches a free slot without moving notes or previous components.
        for (;;) {
          const collisions = occupied.filter((other) => rectanglesOverlap(placed, other))
          if (!collisions.length) break
          placed.position.y = Math.ceil(Math.max(...collisions.map((other) => other.position.y + other.height + G.rowGap)) / G.grid) * G.grid
        }
        positions[id] = placed.position
        y = placed.position.y + node.height + G.rowGap
        bottom = Math.max(bottom, y)
      }
      x += Math.max(...list.map((id) => byId.get(id)!.width)) + G.columnGap
    }
    top = snap(bottom + G.rowGap)
  }
  return positions
}

/** Long and backward connections use exterior lanes instead of crossing intermediate cards. Close forward connections stay direct: their offset shrinks to the available gap in the edge renderer. */
export function flowEdgeRoutes({ nodes, edges }: LayoutGraph): (FlowEdgeRoute | undefined)[] {
  const executable = nodes.filter((node) => node.kind !== 'note')
  const byId = new Map(executable.map((node) => [node.id, node]))
  const columnRight = new Map<number, number>()
  for (const node of executable) columnRight.set(node.position.x, Math.max(columnRight.get(node.position.x) ?? -Infinity, node.position.x + node.width))
  let lane = 0
  return edges.map((edge) => {
    const source = byId.get(edge.source), target = byId.get(edge.target)
    if (!source || !target) return undefined
    const distance = target.position.x - source.position.x - source.width
    if (distance >= 0 && distance <= G.columnGap + G.width / 2) return undefined
    const sourceLaneX = columnRight.get(source.position.x)! + 24, targetLaneX = target.position.x - 24
    // The horizontal run only crosses cards between the two lanes, so the detour clears those instead of the whole graph.
    const left = Math.min(sourceLaneX, targetLaneX), right = Math.max(sourceLaneX, targetLaneX)
    let bottom = Math.max(source.position.y + source.height, target.position.y + target.height)
    for (const node of executable) if (node.position.x < right && node.position.x + node.width > left) bottom = Math.max(bottom, node.position.y + node.height)
    return { outsideY: bottom + G.rowGap + lane++ * 12, sourceLaneX, targetLaneX }
  })
}
