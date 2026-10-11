import { describe, expect, it } from 'vitest'
import { matchExistingRows, parseBulk, serializeBulk } from './bulk-edit'

describe('bulk-edit', () => {
  it('serializa uma linha por entrada, com // nas desativadas', () => {
    expect(
      serializeBulk([
        { name: 'a', value: '1', enabled: true },
        { name: 'b', value: '2', enabled: false },
      ]),
    ).toBe('a:1\n// b:2')
  })

  it('separa no primeiro dois-pontos e preserva os demais no valor', () => {
    expect(parseBulk('Referer: https://x.dev:8080/p')).toEqual([
      { name: 'Referer', value: 'https://x.dev:8080/p', enabled: true },
    ])
  })

  it('ignora linhas vazias, aceita CRLF e linhas sem valor', () => {
    expect(parseBulk('a:1\r\n\r\n  \nflag')).toEqual([
      { name: 'a', value: '1', enabled: true },
      { name: 'flag', value: '', enabled: true },
    ])
  })

  it('lê // como desativada, ou como texto quando desativadas não são permitidas', () => {
    expect(parseBulk('// a:1')).toEqual([{ name: 'a', value: '1', enabled: false }])
    expect(parseBulk('// a:1', { allowDisabled: false })).toEqual([{ name: '// a', value: '1', enabled: true }])
  })

  it('faz round-trip', () => {
    const rows = [
      { name: 'x', value: 'y', enabled: true },
      { name: 'z', value: '', enabled: false },
    ]
    expect(parseBulk(serializeBulk(rows))).toEqual(rows)
  })

  it('associa linhas existentes por nome e depois por posição', () => {
    const existing = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
    const matched = matchExistingRows(existing, [{ name: 'c' }, { name: 'novo' }, { name: 'a' }, { name: 'extra' }])
    expect(matched[0]).toBe(existing[2])
    expect(matched[1]).toBe(existing[1])
    expect(matched[2]).toBe(existing[0])
    expect(matched[3]).toBeUndefined()
  })
})
