import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isPngPath, readImageRequest } from './image-import'

const importCollections = vi.fn()

vi.mock('../../bindings/import-collections', () => ({
  importCollections: (...args: unknown[]) => importCollections(...args),
}))

const request = {
  id: 'r1',
  name: 'Buscar',
  protocol: 'graphql',
  endpoint: 'https://api.test/graphql',
  method: 'post',
  body: 'query { me { id } }',
  restBody: null,
  variables: '{}',
  headers: [],
  authentication: { type: 'none' },
  preRequestScript: '',
  postResponseScript: '',
}

const folder = (requests: unknown[], folders: unknown[] = []) => ({
  id: 'f',
  name: 'f',
  folders,
  requests,
  authentication: { type: 'none' },
})

describe('image-import', () => {
  beforeEach(() => importCollections.mockReset())

  it('reconhece PNG pela extensão', () => {
    expect(isPngPath('/tmp/Captura.PNG')).toBe(true)
    expect(isPngPath('/tmp/colecao.json')).toBe(false)
  })

  it('devolve a primeira requisição, inclusive dentro de pastas', async () => {
    importCollections.mockResolvedValue({ ok: true, value: { collections: [folder([], [folder([request])])], environments: [] } })

    const result = await readImageRequest('/tmp/a.png', '/ws')

    expect(result).toMatchObject({
      ok: true,
      request: { name: 'Buscar', content: { protocol: 'graphql', endpointUrl: 'https://api.test/graphql', query: 'query { me { id } }' } },
    })
  })

  it('repassa o erro e avisa quando não há requisição', async () => {
    importCollections.mockResolvedValueOnce({ ok: false, error: { kind: 'invalid', message: 'sem dados' } })
    expect(await readImageRequest('/tmp/a.png', '/ws')).toEqual({ ok: false, message: 'sem dados' })

    importCollections.mockResolvedValueOnce({ ok: true, value: { collections: [folder([])], environments: [] } })
    expect(await readImageRequest('/tmp/a.png', '/ws')).toEqual({ ok: false, message: null })
  })
})
