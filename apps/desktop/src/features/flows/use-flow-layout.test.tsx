import { useState } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFlowLayout } from './use-flow-layout'
import { toFlowNodes } from './flow-canvas-mapping'
import { layoutFlowGraph } from './flow-layout'
import type { LayoutGraph } from './flow-layout'
import type { FlowNode } from './flow-canvas-mapping'

class LayoutWorker {
  static instances: LayoutWorker[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  terminate = vi.fn()
  graph!: LayoutGraph
  constructor() { LayoutWorker.instances.push(this) }
  postMessage(graph: LayoutGraph) { this.graph = graph }
  finish() { this.onmessage?.({ data: { positions: layoutFlowGraph(this.graph) } } as MessageEvent) }
}
const initial = toFlowNodes([{ id: 'start', kind: 'start', position: { x: 5, y: 8 } }, { id: 'request', kind: 'request', requestId: '', position: { x: 10, y: 20 } }])
const edges = [{ id: 'edge', source: 'start', target: 'request' }]
function setup() {
  const onError = vi.fn(), onOrganized = vi.fn()
  const hook = renderHook(() => {
    const [nodes, setNodes] = useState<FlowNode[]>(initial)
    return { ...useFlowLayout(nodes, edges, setNodes, onOrganized, onError), nodes, setNodes }
  })
  return { ...hook, onError, onOrganized }
}
beforeEach(() => { LayoutWorker.instances = []; vi.stubGlobal('Worker', LayoutWorker) })
afterEach(() => vi.unstubAllGlobals())

describe('flow organization lifecycle', () => {
  it('preserves initial positions until explicitly organized and restores them with undo', () => {
    const { result } = setup()
    expect(result.current.nodes).toEqual(initial)
    expect(LayoutWorker.instances).toHaveLength(0)
    act(() => result.current.organize())
    expect(result.current.organizing).toBe(true)
    act(() => LayoutWorker.instances[0].finish())
    expect(result.current.nodes).not.toEqual(initial)
    expect(result.current.canUndo).toBe(true)
    act(() => result.current.restore())
    expect(result.current.nodes).toEqual(initial)
    expect(result.current.canUndo).toBe(false)
  })

  it('invalidates undo after a manual move even if the node is subsequently moved back', () => {
    const { result } = setup()
    act(() => result.current.organize())
    act(() => LayoutWorker.instances[0].finish())
    const organized = result.current.nodes
    act(() => result.current.setNodes((nodes) => nodes.map((node) => ({ ...node, position: { ...node.position, x: node.position.x + 16 } }))))
    expect(result.current.canUndo).toBe(false)
    act(() => result.current.setNodes(organized))
    expect(result.current.canUndo).toBe(false)
  })

  it('discards stale work when a node moves and cancels work without changing positions', () => {
    const { result } = setup()
    act(() => result.current.organize())
    const running = LayoutWorker.instances[0]
    act(() => result.current.setNodes((nodes) => nodes.map((node) => ({ ...node, position: { x: 900, y: 100 } }))))
    const moved = result.current.nodes
    act(() => running.finish())
    expect(running.terminate).toHaveBeenCalled()
    expect(result.current.nodes).toEqual(moved)
    act(() => result.current.organize())
    act(() => result.current.cancel())
    act(() => LayoutWorker.instances[1].finish())
    expect(result.current.nodes).toEqual(moved)
    expect(result.current.canUndo).toBe(false)
  })

  it('reports worker failures and terminates work on unmount', () => {
    const { result, onError, unmount } = setup()
    act(() => result.current.organize())
    act(() => LayoutWorker.instances[0].onerror?.())
    expect(onError).toHaveBeenCalledOnce()
    expect(result.current.nodes).toEqual(initial)
    act(() => result.current.organize())
    unmount()
    expect(LayoutWorker.instances[1].terminate).toHaveBeenCalled()
  })
})
