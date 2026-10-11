import { describe, expect, it } from 'vitest'
import { keyboardMove, moveById } from './reorder'

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
const ids = (list: { id: string }[]) => list.map((item) => item.id)

describe('moveById', () => {
  it('move um item para antes do alvo', () => {
    expect(ids(moveById(items, 'd', 'b', 'before'))).toEqual(['a', 'd', 'b', 'c'])
  })

  it('move um item para depois do alvo', () => {
    expect(ids(moveById(items, 'a', 'c', 'after'))).toEqual(['b', 'c', 'a', 'd'])
  })

  it('devolve a mesma referência quando a posição não muda', () => {
    expect(moveById(items, 'b', 'c', 'before')).toBe(items)
    expect(moveById(items, 'c', 'b', 'after')).toBe(items)
    expect(moveById(items, 'b', 'b', 'after')).toBe(items)
  })

  it('ignora ids desconhecidos', () => {
    expect(moveById(items, 'x', 'a', 'before')).toBe(items)
    expect(moveById(items, 'a', 'x', 'after')).toBe(items)
  })
})

describe('keyboardMove', () => {
  const order = ['a', 'b', 'c', 'd']

  it('sobe e desce uma posição', () => {
    expect(keyboardMove(order, 'c', 'ArrowUp')).toEqual({ targetId: 'b', edge: 'before', position: 2 })
    expect(keyboardMove(order, 'b', 'ArrowDown')).toEqual({ targetId: 'c', edge: 'after', position: 3 })
  })

  it('leva ao início e ao fim', () => {
    expect(keyboardMove(order, 'c', 'Home')).toEqual({ targetId: 'a', edge: 'before', position: 1 })
    expect(keyboardMove(order, 'b', 'End')).toEqual({ targetId: 'd', edge: 'after', position: 4 })
  })

  it('não move além dos limites', () => {
    expect(keyboardMove(order, 'a', 'ArrowUp')).toBeNull()
    expect(keyboardMove(order, 'a', 'Home')).toBeNull()
    expect(keyboardMove(order, 'd', 'ArrowDown')).toBeNull()
    expect(keyboardMove(order, 'd', 'End')).toBeNull()
  })
})
