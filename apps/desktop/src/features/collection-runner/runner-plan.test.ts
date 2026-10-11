import { describe, expect, it } from 'vitest'
import { emptyRequestContent } from '../request-workbench/collection-tree'
import type { RequestProtocol, TreeNode } from '../request-workbench/collection-tree'
import {
  flattenScope,
  reconcileOrder,
  reorderPlan,
  rootCollectionOf,
  scopePath,
  selectedInOrder,
} from './runner-plan'

function request(id: string, protocol: RequestProtocol = 'rest') {
  return { id, name: `Req ${id}`, protocol, content: emptyRequestContent(protocol) }
}

function node(id: string, folders: TreeNode[] = [], requests: ReturnType<typeof request>[] = []): TreeNode {
  return { id, name: `N ${id}`, folders, requests, authentication: { type: 'none' }, variables: [] }
}

const collection = node('c', [node('f1', [node('f2', [], [request('deep')])], [request('a', 'graphql')])], [request('root')])

describe('flattenScope', () => {
  it('segue a ordem da sidebar: pastas primeiro, em profundidade', () => {
    const items = flattenScope(collection)

    expect(items.map((item) => item.id)).toEqual(['deep', 'a', 'root'])
    expect(items[0].path).toEqual(['N f1', 'N f2'])
    expect(items[1]).toMatchObject({ protocol: 'graphql', method: 'post', path: ['N f1'] })
    expect(items[2].path).toEqual([])
  })
})

describe('reconcileOrder', () => {
  it('mantém a ordem escolhida, remove os ausentes e acrescenta os novos', () => {
    const items = flattenScope(collection)

    expect(reconcileOrder(['root', 'gone', 'deep'], items)).toEqual(['root', 'deep', 'a'])
  })
})

describe('reorderPlan', () => {
  it('move antes ou depois do alvo', () => {
    expect(reorderPlan(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b'])
    expect(reorderPlan(['a', 'b', 'c'], 'a', 'b', 'after')).toEqual(['b', 'a', 'c'])
    expect(reorderPlan(['a', 'b'], 'a', 'a', 'after')).toEqual(['a', 'b'])
    expect(reorderPlan(['a', 'b'], 'x', 'a', 'after')).toEqual(['a', 'b'])
  })
})

describe('selectedInOrder', () => {
  it('filtra os desmarcados preservando a ordem', () => {
    expect(selectedInOrder(['c', 'a', 'b'], new Set(['a']))).toEqual(['c', 'b'])
  })
})

describe('rootCollectionOf / scopePath', () => {
  it('acha a coleção raiz de uma requisição aninhada e o caminho de uma pasta', () => {
    expect(rootCollectionOf([node('other'), collection], 'deep')?.id).toBe('c')
    expect(rootCollectionOf([collection], 'nope')).toBeNull()
    expect(scopePath([collection], 'f2')).toEqual(['N c', 'N f1', 'N f2'])
    expect(scopePath([collection], 'nope')).toBeNull()
  })
})
