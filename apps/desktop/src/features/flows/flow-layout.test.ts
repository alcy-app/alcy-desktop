import { describe, expect, it } from 'vitest'
import { FLOW_GEOMETRY as G, flowNodeSize } from './flow-geometry'
import { flowEdgeRoutes, layoutFlowGraph, rectanglesOverlap } from './flow-layout'
import type { LayoutGraph, LayoutNode } from './flow-layout'

function node(id: string, kind = 'request', x = 0, y = 0): LayoutNode {
  return { id, kind, position: { x, y }, ...flowNodeSize(kind, kind === 'request' ? 2 : 0) }
}
function expectNoOverlap(graph: LayoutGraph) {
  const positions = layoutFlowGraph(graph)
  const placed = graph.nodes.map((item) => ({ ...item, position: positions[item.id] }))
  for (let a = 0; a < placed.length; a++) for (let b = a + 1; b < placed.length; b++) expect(rectanglesOverlap(placed[a], placed[b], 0), `${placed[a].id} / ${placed[b].id}`).toBe(false)
  return positions
}

describe('compact flow layout', () => {
  it('uses the larger Display bounds when arranging a branch and a merge', () => {
    const graph: LayoutGraph = { nodes: [node('start', 'start'), node('request'), node('display', 'display'), node('fallback'), node('end')], edges: [{ source: 'start', target: 'request' }, { source: 'request', target: 'display', sourceHandle: 'success' }, { source: 'request', target: 'fallback', sourceHandle: 'failure' }, { source: 'display', target: 'end' }, { source: 'fallback', target: 'end' }] }
    const positions = expectNoOverlap(graph)
    const display = graph.nodes.find((item) => item.id === 'display')!
    expect(positions.end.x).toBeGreaterThanOrEqual(positions.display.x + display.width + G.columnGap)
    expect(Math.abs(positions.display.y - positions.fallback.y)).toBeGreaterThanOrEqual((display.height + graph.nodes[3].height) / 2 + G.rowGap)
  })
  it.each([3, 10, 30])('places a %i-node chain in readable columns without mutating saved positions', (count) => {
    const graph: LayoutGraph = { nodes: Array.from({ length: count }, (_, index) => node(String(index), index === 0 ? 'start' : 'request', index * 7, index * -13)), edges: Array.from({ length: count - 1 }, (_, index) => ({ source: String(index), target: String(index + 1) })) }
    const saved = structuredClone(graph)
    const result = expectNoOverlap(graph)
    expect(graph).toEqual(saved)
    for (const edge of graph.edges) expect(result[edge.target].x - result[edge.source].x).toBeGreaterThanOrEqual(G.compactWidth + G.columnGap)
    expect(layoutFlowGraph(graph)).toEqual(result)
    expect(layoutFlowGraph({ ...graph, nodes: [...graph.nodes].reverse() })).toEqual(result)
    expect(layoutFlowGraph({ ...graph, edges: [...graph.edges].reverse() })).toEqual(result)
  })

  it('keeps success above failure and converges in a later column', () => {
    const graph: LayoutGraph = { nodes: [node('start', 'start'), node('z-success'), node('a-failure'), node('join')], edges: [{ source: 'start', target: 'z-success', sourceHandle: 'success' }, { source: 'start', target: 'a-failure', sourceHandle: 'failure' }, { source: 'z-success', target: 'join' }, { source: 'a-failure', target: 'join' }] }
    const result = expectNoOverlap(graph)
    expect(result['z-success'].x).toBe(result['a-failure'].x)
    expect(result['z-success'].y).toBeLessThan(result['a-failure'].y)
    expect(result.join.x).toBeGreaterThan(result['z-success'].x)
    expect(layoutFlowGraph({ ...graph, nodes: graph.nodes.map((item) => ({ ...item, position: result[item.id] })) })).toEqual(result)
  })

  it('preserves fixed notes and puts disconnected components below the main flow', () => {
    const note = { ...node('note', 'note'), width: 400, height: 180 }
    const graph: LayoutGraph = { nodes: [node('start', 'start'), node('request'), node('disconnected'), note], edges: [{ source: 'start', target: 'request' }] }
    const result = expectNoOverlap(graph)
    expect(result.note).toEqual(note.position)
    expect(result.disconnected.y).toBeGreaterThan(result.request.y + graph.nodes[1].height)
  })

  it('groups cycles without losing nodes or hanging on invalid references', () => {
    const graph: LayoutGraph = { nodes: [node('start', 'start'), node('a'), node('b'), node('tail')], edges: [{ source: 'start', target: 'a' }, { source: 'a', target: 'b' }, { source: 'b', target: 'a' }, { source: 'b', target: 'tail' }, { source: 'missing', target: 'tail' }] }
    const result = expectNoOverlap(graph)
    expect(result.a.x).toBe(result.b.x)
    expect(result.a.y).not.toBe(result.b.y)
    expect(result.tail.x).toBeGreaterThan(result.a.x)
  })

  it('uses exterior lanes for backward and skipping edges', () => {
    const nodes = [node('a', 'request', 0, 0), node('b', 'request', 352, 0), node('c', 'request', 704, 0)]
    const routes = flowEdgeRoutes({ nodes, edges: [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }, { source: 'c', target: 'a' }] })
    expect(routes[0]).toBeUndefined()
    expect(routes[1]?.outsideY).toBeGreaterThan(nodes[0].height)
    expect(routes[2]?.outsideY).toBeGreaterThan(routes[1]!.outsideY)
    const compact = node('small', 'start', 0, 0), large = node('large', 'request', 0, 100)
    expect(flowEdgeRoutes({ nodes: [compact, large], edges: [{ source: 'small', target: 'large' }] })[0]?.sourceLaneX).toBeGreaterThan(large.width)
  })

  it('keeps close forward connections direct instead of looping below the graph', () => {
    const start = node('start', 'start', 0, 0), request = node('request', 'request', 184, 0)
    expect(flowEdgeRoutes({ nodes: [start, request], edges: [{ source: 'start', target: 'request' }] })[0]).toBeUndefined()
    const distant = node('distant', 'request', 0, 4000)
    expect(flowEdgeRoutes({ nodes: [start, request, distant], edges: [{ source: 'start', target: 'request' }] })[0]).toBeUndefined()
  })

  it('detours only under the cards the exterior run crosses', () => {
    const head = node('head', 'request', 0, 0), tail = node('tail', 'request', 704, 0)
    const distant = node('distant', 'request', 0, 4000)
    const route = flowEdgeRoutes({ nodes: [head, tail, distant], edges: [{ source: 'head', target: 'tail' }] })[0]!
    expect(route.outsideY).toBeLessThan(distant.position.y)
    const between = node('between', 'display', 352, 800)
    const cleared = flowEdgeRoutes({ nodes: [head, tail, between], edges: [{ source: 'head', target: 'tail' }] })[0]!
    expect(cleared.outsideY).toBeGreaterThan(between.position.y + between.height)
  })

  it('handles empty graphs and long chains without recursive stack limits', () => {
    expect(layoutFlowGraph({ nodes: [], edges: [] })).toEqual({})
    const nodes = Array.from({ length: 3000 }, (_, index) => node(String(index)))
    const edges = nodes.slice(1).map((item, index) => ({ source: String(index), target: item.id }))
    expect(Object.keys(layoutFlowGraph({ nodes, edges }))).toHaveLength(nodes.length)
  })

  it('supports reference IDs that coincide with object prototype names', () => {
    const graph = { nodes: [node('__proto__'), node('constructor')], edges: [{ source: '__proto__', target: 'constructor' }] }
    const positions = layoutFlowGraph(graph)
    expect(Object.keys(positions)).toHaveLength(2)
    expect(positions[graph.nodes[1].id].x).toBeGreaterThan(positions[graph.nodes[0].id].x)
  })
})
