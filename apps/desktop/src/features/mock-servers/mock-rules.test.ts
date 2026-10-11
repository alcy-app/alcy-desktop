import { describe, expect, it } from 'vitest'
import { parseConditionGroup, routePathParameters } from './mock-rules'

describe('mock-rules', () => {
  it('lista os parâmetros declarados no caminho da rota', () => {
    expect(routePathParameters('/users/:id/posts/:postId')).toEqual(['id', 'postId'])
    expect(routePathParameters('/health')).toEqual([])
  })

  it('aceita regras aninhadas válidas e rejeita estruturas que o editor visual não representa', () => {
    const valid = { operator: 'any', conditions: [
      { kind: 'match', source: 'query', key: 'page', operator: 'equals', value: '1' },
      { kind: 'group', group: { operator: 'all', conditions: [] } },
    ] }
    expect(parseConditionGroup(valid)).toEqual(valid)
    expect(parseConditionGroup({ operator: 'all' })).toBeNull()
    expect(parseConditionGroup({ operator: 'all', conditions: [{ kind: 'match', source: 'cookie', key: 'a', operator: 'equals', value: '' }] })).toBeNull()
    expect(parseConditionGroup({ operator: 'all', conditions: [{ kind: 'match', source: 'query', key: 'a', operator: 'equals' }] })).toBeNull()
    expect(parseConditionGroup({ operator: 'all', conditions: [{ kind: 'group', group: { operator: 'none', conditions: [] } }] })).toBeNull()
  })
})
