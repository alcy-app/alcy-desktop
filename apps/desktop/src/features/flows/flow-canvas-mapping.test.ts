import { describe, expect, it, vi } from 'vitest'
import { snapViewportToWholePixels, terminalFlowNodeIds } from './flow-canvas-mapping'

describe('snapViewportToWholePixels', () => {
  it('rounds fractional offsets without changing zoom', () => {
    const setViewport = vi.fn().mockResolvedValue(true)

    snapViewportToWholePixels({ setViewport }, { x: 10.4, y: -3.6, zoom: 1.37 })

    expect(setViewport).toHaveBeenCalledWith({ x: 10, y: -4, zoom: 1.37 })
  })

  it('leaves whole-pixel offsets unchanged to avoid a feedback loop', () => {
    const setViewport = vi.fn().mockResolvedValue(true)

    snapViewportToWholePixels({ setViewport }, { x: 10, y: -4, zoom: 1.37 })

    expect(setViewport).not.toHaveBeenCalled()
  })
})

describe('flow endpoint accents', () => {
  it('marks every connected leaf, skips annotations and ignores dangling edges', () => {
    const nodes = [{ id: 'start', type: 'start' }, { id: 'request', type: 'request' }, { id: 'success', type: 'display' }, { id: 'failure', type: 'log' }, { id: 'note', type: 'note' }, { id: 'unused', type: 'display' }]
    const edges = [{ source: 'start', target: 'request' }, { source: 'request', target: 'success' }, { source: 'request', target: 'failure' }, { source: 'success', target: 'missing' }, { source: 'request', target: 'note' }]
    expect(terminalFlowNodeIds(nodes, edges)).toEqual(new Set(['success', 'failure']))
    expect(terminalFlowNodeIds(nodes, [...edges, { source: 'failure', target: 'request' }])).toEqual(new Set(['success']))
  })
})
