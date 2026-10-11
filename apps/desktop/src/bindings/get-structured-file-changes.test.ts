import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getStructuredFileChanges } from './get-structured-file-changes'

const invokeResult = vi.fn()

vi.mock('./invoke-result', () => ({
  invokeResult: (...args: unknown[]) => invokeResult(...args),
}))

beforeEach(() => invokeResult.mockReset())

describe('getStructuredFileChanges', () => {
  it('reúne páginas usando as revisões do snapshot', async () => {
    invokeResult
      .mockResolvedValueOnce({
        ok: true,
        value: {
          name: 'alcy-collections.json', localRevision: 'local-actual', remoteRevision: 'remote-actual',
          supportsPartial: true, totalItems: 2, nextOffset: 1,
          items: [{ id: 'request:1', parentId: null, label: 'One', itemKind: 'request', changeKind: 'modified', fields: [], dependencies: [] }],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          name: 'alcy-collections.json', localRevision: 'local-actual', remoteRevision: 'remote-actual',
          supportsPartial: true, totalItems: 2, nextOffset: null,
          items: [{ id: 'request:2', parentId: null, label: 'Two', itemKind: 'request', changeKind: 'added', fields: [], dependencies: [] }],
        },
      })

    const result = await getStructuredFileChanges('/workspace', 'operation', 'alcy-collections.json', 'remote-known', 'local-known')

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        totalItems: 2,
        nextOffset: null,
        items: [expect.objectContaining({ id: 'request:1' }), expect.objectContaining({ id: 'request:2' })],
      }),
    })
    expect(invokeResult).toHaveBeenNthCalledWith(1, 'get_structured_file_changes', {
      input: expect.objectContaining({ offset: 0, limit: 200, expectedLocalRevision: 'local-known', expectedRemoteRevision: 'remote-known' }),
    })
    expect(invokeResult).toHaveBeenNthCalledWith(2, 'get_structured_file_changes', {
      input: expect.objectContaining({ offset: 1, expectedLocalRevision: 'local-actual', expectedRemoteRevision: 'remote-actual' }),
    })
  })

  it('interrompe a paginação no primeiro erro estruturado', async () => {
    const error = { kind: 'network', message: 'offline' }
    invokeResult.mockResolvedValue({ ok: false, error })

    await expect(getStructuredFileChanges('/workspace', 'operation', 'file.json')).resolves.toEqual({ ok: false, error })
    expect(invokeResult).toHaveBeenCalledTimes(1)
  })
})
