import { describe, expect, it } from 'vitest'
import { emptyRequestContent } from '../request-workbench/collection-tree'
import type { TreeNode } from '../request-workbench/collection-tree'
import type { FlowNodeState } from './flows.types'
import { buildRequestChain, requestIdsForItem, startWithoutOutput } from './request-chain'

function request(id: string) {
  return { id, name: `Req ${id}`, protocol: 'rest' as const, content: emptyRequestContent('rest') }
}

function node(id: string, folders: TreeNode[] = [], requests: ReturnType<typeof request>[] = []): TreeNode {
  return { id, name: `N ${id}`, folders, requests, authentication: { type: 'none' }, variables: [] }
}

const collections = [node('c', [node('f1', [node('f2', [], [request('deep')])], [request('a')]), node('empty')], [request('root')])]

function sequentialIds() {
  let next = 0
  return () => `id-${next++}`
}

describe('requestIdsForItem', () => {
  it('gera só a própria requisição', () => {
    expect(requestIdsForItem(collections, 'a')).toEqual({ name: 'Req a', requestIds: ['a'] })
  })

  it('percorre uma pasta recursivamente na ordem da sidebar', () => {
    expect(requestIdsForItem(collections, 'c')).toEqual({ name: 'N c', requestIds: ['deep', 'a', 'root'] })
    expect(requestIdsForItem(collections, 'f1')?.requestIds).toEqual(['deep', 'a'])
  })

  it('devolve lista vazia para pasta sem requisições e null para item inexistente', () => {
    expect(requestIdsForItem(collections, 'empty')).toEqual({ name: 'N empty', requestIds: [] })
    expect(requestIdsForItem(collections, 'nope')).toBeNull()
  })
})

describe('buildRequestChain', () => {
  it('encadeia as requisições pela saída de sucesso e liga o node de origem ao primeiro', () => {
    const { nodes, edges } = buildRequestChain(['a', 'b', 'c'], { x: 100, y: 50 }, 'start', sequentialIds())

    expect(nodes.map((current) => current.kind === 'request' && current.requestId)).toEqual(['a', 'b', 'c'])
    expect(nodes.map((current) => current.position)).toEqual([
      { x: 100, y: 50 },
      { x: 460, y: 50 },
      { x: 820, y: 50 },
    ])
    expect(edges).toEqual([
      { id: 'id-3', sourceNodeId: 'start', targetNodeId: 'id-0' },
      { id: 'id-4', sourceNodeId: 'id-0', targetNodeId: 'id-1', sourceHandle: 'success' },
      { id: 'id-5', sourceNodeId: 'id-1', targetNodeId: 'id-2', sourceHandle: 'success' },
    ])
  })

  it('nasce solta sem node de origem', () => {
    const { edges } = buildRequestChain(['a', 'b'], { x: 0, y: 0 }, null, sequentialIds())

    expect(edges).toHaveLength(1)
    expect(edges[0].sourceNodeId).toBe('id-0')
  })

  it('quebra a grade depois de cinco colunas', () => {
    const { nodes } = buildRequestChain(['1', '2', '3', '4', '5', '6'], { x: 0, y: 0 }, null, sequentialIds())

    expect(nodes[5].position).toEqual({ x: 0, y: 220 })
  })

  it('não gera nada para uma lista vazia', () => {
    expect(buildRequestChain([], { x: 0, y: 0 }, 'start')).toEqual({ nodes: [], edges: [] })
  })
})

describe('startWithoutOutput', () => {
  const nodes: FlowNodeState[] = [
    { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
    { id: 'r', kind: 'request', requestId: 'a', position: { x: 360, y: 0 } },
  ]

  it('devolve o Start só enquanto ele não tem saída', () => {
    expect(startWithoutOutput(nodes, [])).toBe('start')
    expect(startWithoutOutput(nodes, [{ id: 'e', sourceNodeId: 'start', targetNodeId: 'r' }])).toBeNull()
  })
})
