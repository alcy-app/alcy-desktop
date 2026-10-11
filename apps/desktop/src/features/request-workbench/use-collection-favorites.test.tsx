import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectionFavoritesStorageKey, loadCollectionFavorites, useCollectionFavorites } from './use-collection-favorites'

const ROOT = '/workspaces/api'

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('useCollectionFavorites', () => {
  it('marca, desmarca e persiste as favoritas por workspace', () => {
    const { result } = renderHook(() => useCollectionFavorites(ROOT))

    act(() => result.current.setFavorites(['a'], true, ['a', 'b']))
    expect([...result.current.favoriteIds]).toEqual(['a'])
    expect(JSON.parse(window.localStorage.getItem(collectionFavoritesStorageKey(ROOT)) ?? '[]')).toEqual(['a'])
    expect(loadCollectionFavorites('/workspaces/outro').size).toBe(0)

    act(() => result.current.setFavorites(['a'], false, ['a', 'b']))
    expect(result.current.favoriteIds.size).toBe(0)
  })

  it('marca e desmarca várias de uma vez', () => {
    const { result } = renderHook(() => useCollectionFavorites(ROOT))

    act(() => result.current.setFavorites(['a', 'b', 'c'], true, ['a', 'b', 'c']))
    expect([...result.current.favoriteIds].sort()).toEqual(['a', 'b', 'c'])

    act(() => result.current.setFavorites(['a', 'c'], false, ['a', 'b', 'c']))
    expect([...result.current.favoriteIds]).toEqual(['b'])
  })

  it('descarta favoritas de collections que não existem mais ao gravar', () => {
    window.localStorage.setItem(collectionFavoritesStorageKey(ROOT), JSON.stringify(['removida', 'a']))
    const { result } = renderHook(() => useCollectionFavorites(ROOT))

    act(() => result.current.setFavorites(['b'], true, ['a', 'b']))

    expect([...result.current.favoriteIds].sort()).toEqual(['a', 'b'])
  })

  it('ignora conteúdo inválido e localStorage indisponível', () => {
    window.localStorage.setItem(collectionFavoritesStorageKey(ROOT), '{"não": "lista"}')
    expect(loadCollectionFavorites(ROOT).size).toBe(0)

    window.localStorage.setItem(collectionFavoritesStorageKey(ROOT), '[1, "a", null]')
    expect([...loadCollectionFavorites(ROOT)]).toEqual(['a'])

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('indisponível')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('indisponível')
    })
    const { result } = renderHook(() => useCollectionFavorites(ROOT))
    expect(result.current.favoriteIds.size).toBe(0)

    act(() => result.current.setFavorites(['a'], true, ['a']))
    expect([...result.current.favoriteIds]).toEqual(['a'])
  })
})
