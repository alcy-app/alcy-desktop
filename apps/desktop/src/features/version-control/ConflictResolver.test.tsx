import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../test-utils'
import type { StructuredFileChangesDto } from '../../bindings/gitlab-types'
import { fakeVersionControl } from './test-fixtures'
import { ConflictResolver } from './ConflictResolver'

const previewConflictResolution = vi.fn()
vi.mock('../../bindings/preview-conflict-resolution', () => ({
  previewConflictResolution: (...args: unknown[]) => previewConflictResolution(...args),
}))
vi.mock('../../bindings/cancel-gitlab-operation', () => ({ cancelGitlabOperation: () => Promise.resolve() }))

const ROOT = '/work/space'
const changes: StructuredFileChangesDto = {
  name: 'alcy-collections.json',
  localRevision: 'local-rev',
  remoteRevision: 'remote-rev',
  supportsPartial: true,
  items: [
    { id: 'request:r1', parentId: 'collection:c1', label: 'List users', itemKind: 'request', changeKind: 'modified', fields: [{ name: 'endpoint', remote: '/users', local: '/v2/users' }], dependencies: [] },
    { id: 'request:r2', parentId: 'collection:c1', label: 'Create user', itemKind: 'request', changeKind: 'modified', fields: [{ name: 'endpoint', remote: '/create', local: '/v2/create' }], dependencies: [] },
  ],
}

beforeEach(() => {
  previewConflictResolution.mockReset()
  previewConflictResolution.mockImplementation((_root: string, _operation: string, _file: string, _items: unknown[], _local: string, _remote: string, itemId: string) => Promise.resolve({
    ok: true,
    value: { itemId, label: itemId === 'request:r1' ? 'List users' : 'Create user', itemKind: 'request', exists: true, fields: [{ name: 'endpoint', value: '/preview' }] },
  }))
})

describe('ConflictResolver', () => {
  it('não pré-seleciona lados e exige decisão para todas as entidades', async () => {
    render(<ConflictResolver rootPath={ROOT} vc={fakeVersionControl()} target={{ fileName: changes.name, changes }} onResolved={() => {}} />)

    expect(screen.getByRole('button', { name: 'Resolver conflito' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Minha versão' }))
    expect(screen.getByRole('button', { name: 'Resolver conflito' })).toBeDisabled()

    fireEvent.click(screen.getByRole('option', { name: /Create user/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Versão do GitLab' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Resolver conflito' })).toBeEnabled())
    expect(previewConflictResolution).toHaveBeenCalledWith(ROOT, expect.any(String), changes.name, [
      { itemId: 'request:r1', side: 'local' },
      { itemId: 'request:r2', side: 'remote' },
    ], 'local-rev', 'remote-rev', 'request:r2')
  })

  it('ações em massa geram a prévia e marcam todos os itens', async () => {
    render(<ConflictResolver rootPath={ROOT} vc={fakeVersionControl()} target={{ fileName: changes.name, changes }} onResolved={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Manter tudo meu' }))

    expect(screen.getByText('2 de 2 itens decididos')).toBeInTheDocument()
    expect(await screen.findByText('/preview')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resolver conflito' })).toBeEnabled()
  })

  it('resolve com a composição escolhida por item', async () => {
    const resolve = vi.fn().mockResolvedValue({ ok: true })
    const onResolved = vi.fn()
    render(<ConflictResolver rootPath={ROOT} vc={fakeVersionControl({ resolve })} target={{ fileName: changes.name, changes }} onResolved={onResolved} />)

    fireEvent.click(screen.getByRole('button', { name: 'Minha versão' }))
    fireEvent.click(screen.getByRole('option', { name: /Create user/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Versão do GitLab' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resolver conflito' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Resolver conflito' }))

    await waitFor(() => expect(resolve).toHaveBeenCalledWith('alcy-collections.json', {
      kind: 'perItem',
      items: [{ itemId: 'request:r1', side: 'local' }, { itemId: 'request:r2', side: 'remote' }],
      expectedLocalRevision: 'local-rev',
      expectedRemoteRevision: 'remote-rev',
    }))
    expect(onResolved).toHaveBeenCalled()
  })

  it('oculta valores sensíveis e permite revelá-los explicitamente', () => {
    const sensitiveChanges: StructuredFileChangesDto = {
      ...changes,
      items: [{
        id: 'environment:e1',
        parentId: null,
        label: 'Development',
        itemKind: 'environment',
        changeKind: 'modified',
        dependencies: [],
        fields: [{
          name: 'variables',
          local: JSON.stringify([{ id: 'v1', name: 'token', value: 'local-secret', sensitive: true }]),
          remote: JSON.stringify([{ id: 'v1', name: 'token', value: 'remote-secret', sensitive: true }]),
        }],
      }],
    }
    render(<ConflictResolver rootPath={ROOT} vc={fakeVersionControl()} target={{ fileName: sensitiveChanges.name, changes: sensitiveChanges }} onResolved={() => {}} />)

    expect(screen.queryByText('local-secret')).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Revelar' })[0])
    expect(screen.getByText('local-secret')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ocultar' })).toBeInTheDocument()
  })

  it('bloqueia aplicação e oferece recarga quando a prévia ficou desatualizada', async () => {
    previewConflictResolution.mockResolvedValue({ ok: false, error: { kind: 'conflict' } })
    const refresh = vi.fn().mockResolvedValue(undefined)
    const onResolved = vi.fn()
    render(<ConflictResolver rootPath={ROOT} vc={fakeVersionControl({ refresh })} target={{ fileName: changes.name, changes }} onResolved={onResolved} />)

    fireEvent.click(screen.getByRole('button', { name: 'Manter tudo meu' }))
    expect(await screen.findByText('O arquivo mudou desde que esta resolução foi aberta. Feche e abra de novo.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resolver conflito' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Recarregar conflito' }))
    expect(refresh).toHaveBeenCalled()
    expect(onResolved).toHaveBeenCalled()
  })
})
