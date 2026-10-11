import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '../../test-utils'
import type { FileStatusDto } from '../../bindings/gitlab-types'
import { useChangedItemMarkers } from './use-changed-items'

const getStructuredFileChanges = vi.fn()
const cancelGitlabOperation = vi.fn()

vi.mock('../../bindings/get-structured-file-changes', () => ({
  getStructuredFileChanges: (...args: unknown[]) => getStructuredFileChanges(...args),
}))
vi.mock('../../bindings/cancel-gitlab-operation', () => ({
  cancelGitlabOperation: (...args: unknown[]) => cancelGitlabOperation(...args),
}))

function Harness({ files }: { files: FileStatusDto[] }) {
  const markers = useChangedItemMarkers('/work/space', files)
  return (
    <ul aria-label="markers">
      {[...markers.entries()].map(([id, kind]) => (
        <li key={id}>{`${id}:${kind}`}</li>
      ))}
    </ul>
  )
}

beforeEach(() => {
  getStructuredFileChanges.mockReset()
  cancelGitlabOperation.mockReset()
})

describe('useChangedItemMarkers', () => {
  it('não consulta nada quando nenhum arquivo rastreado tem diferença', () => {
    render(<Harness files={[{ name: 'alcy-collections.json', state: 'clean' }]} />)

    expect(getStructuredFileChanges).not.toHaveBeenCalled()
    expect(screen.getByLabelText('markers')).toBeEmptyDOMElement()
  })

  it('monta o mapa id do item (sem o prefixo de kind) → tipo de alteração', async () => {
    getStructuredFileChanges.mockResolvedValue({
      ok: true,
      value: {
        name: 'alcy-collections.json',
        localRevision: 'local',
        remoteRevision: 'remote',
        supportsPartial: true,
        items: [
          { id: 'folder:f1', parentId: null, label: 'Usuários', itemKind: 'folder', changeKind: 'added', fields: [], dependencies: [] },
          { id: 'request:r1', parentId: 'folder:f1', label: 'List users', itemKind: 'request', changeKind: 'modified', fields: [], dependencies: [] },
        ],
      },
    })

    render(<Harness files={[{ name: 'alcy-collections.json', state: 'localModified' }]} />)

    expect(await screen.findByText('f1:added')).toBeInTheDocument()
    expect(screen.getByText('r1:modified')).toBeInTheDocument()
    expect(getStructuredFileChanges).toHaveBeenCalledWith('/work/space', expect.any(String), 'alcy-collections.json', undefined, undefined)
  })

  it('recarrega os indicadores quando a revisão muda sem alterar o estado do arquivo', async () => {
    getStructuredFileChanges
      .mockResolvedValueOnce({
        ok: true,
        value: {
          name: 'alcy-collections.json',
          localRevision: 'local-1',
          remoteRevision: 'remote',
          supportsPartial: true,
          items: [{ id: 'request:first', parentId: null, label: 'Primeiro', itemKind: 'request', changeKind: 'modified', fields: [], dependencies: [] }],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          name: 'alcy-collections.json',
          localRevision: 'local-2',
          remoteRevision: 'remote',
          supportsPartial: true,
          items: [{ id: 'request:second', parentId: null, label: 'Segundo', itemKind: 'request', changeKind: 'added', fields: [], dependencies: [] }],
        },
      })

    const view = render(<Harness files={[{
      name: 'alcy-collections.json',
      state: 'localModified',
      localRevision: 'local-1',
      remoteRevision: 'remote',
    }]} />)
    expect(await screen.findByText('first:modified')).toBeInTheDocument()

    view.rerender(<Harness files={[{
      name: 'alcy-collections.json',
      state: 'localModified',
      localRevision: 'local-2',
      remoteRevision: 'remote',
    }]} />)

    expect(await screen.findByText('second:added')).toBeInTheDocument()
    await waitFor(() => expect(getStructuredFileChanges).toHaveBeenCalledTimes(2))
  })

  it('ignora um resultado sem sucesso em vez de propagar o erro', async () => {
    getStructuredFileChanges.mockResolvedValue({ ok: false, error: { kind: 'network', message: 'offline' } })

    render(<Harness files={[{ name: 'alcy-flows.json', state: 'localAdded' }]} />)

    await Promise.resolve()
    expect(screen.getByLabelText('markers')).toBeEmptyDOMElement()
  })
})
