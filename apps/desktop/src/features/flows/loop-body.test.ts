import { describe, expect, it } from 'vitest'
import type { FlowEdgeState } from './flows.types'
import { loopBodyOf, whilesWithOpenBody } from './loop-body'

// start -> w -loop-> a -> b ; w -done-> c
const edges: FlowEdgeState[] = [
  { id: 'e1', sourceNodeId: 'start', targetNodeId: 'w' },
  { id: 'e2', sourceNodeId: 'w', targetNodeId: 'a', sourceHandle: 'loop' },
  { id: 'e3', sourceNodeId: 'a', targetNodeId: 'b' },
  { id: 'e4', sourceNodeId: 'w', targetNodeId: 'c', sourceHandle: 'done' },
]

describe('loopBodyOf', () => {
  it('collects everything reachable from the loop output only', () => {
    expect([...loopBodyOf('w', edges)].sort()).toEqual(['a', 'b'])
  })
})

describe('whilesWithOpenBody', () => {
  it('accepts a closed body', () => {
    expect(whilesWithOpenBody(['w'], edges).size).toBe(0)
  })

  it('flags an edge leaving the body', () => {
    const open = whilesWithOpenBody(['w'], [...edges, { id: 'x', sourceNodeId: 'b', targetNodeId: 'c' }])
    expect([...open]).toEqual(['w'])
  })

  it('flags an edge entering the body from outside the loop output', () => {
    const open = whilesWithOpenBody(['w'], [...edges, { id: 'x', sourceNodeId: 'start', targetNodeId: 'b' }])
    expect([...open]).toEqual(['w'])
  })
})
