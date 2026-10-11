import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../test-utils'
import { StartScreen } from './StartScreen'

const createWorkspace = vi.fn()
const openWorkspace = vi.fn()
const listRecentWorkspaces = vi.fn()
const pickWorkspaceFolder = vi.fn()

vi.mock('../../bindings/create-workspace', () => ({
  createWorkspace: (...args: unknown[]) => createWorkspace(...args),
}))

vi.mock('../../bindings/open-workspace', () => ({
  openWorkspace: (...args: unknown[]) => openWorkspace(...args),
}))

vi.mock('../../bindings/list-recent-workspaces', () => ({
  listRecentWorkspaces: (...args: unknown[]) => listRecentWorkspaces(...args),
}))

vi.mock('../../bindings/pick-workspace-folder', () => ({
  pickWorkspaceFolder: (...args: unknown[]) => pickWorkspaceFolder(...args),
}))

beforeEach(() => {
  createWorkspace.mockReset()
  openWorkspace.mockReset()
  listRecentWorkspaces.mockReset()
  pickWorkspaceFolder.mockReset()
  listRecentWorkspaces.mockResolvedValue({ ok: true, value: [] })
})

describe('StartScreen', () => {
  it('renderiza os controles principais', async () => {
    render(<StartScreen onWorkspaceReady={vi.fn()} />)

    expect(screen.getByRole('heading', { name: 'Alcy' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Criar workspace local' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Abrir workspace existente' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Importar OpenAPI ou Collection' })).toBeDisabled()

    await waitFor(() => expect(listRecentWorkspaces).toHaveBeenCalled())
  })

  it('cria um workspace direto, sem diálogo de pasta, e avisa quando pronto', async () => {
    createWorkspace.mockResolvedValue({
      ok: true,
      value: { id: 'workspace-1', name: 'Workspace', rootPath: '/home/user/Documents/Alcy Workspaces/Workspace' },
    })
    const onWorkspaceReady = vi.fn()

    render(<StartScreen onWorkspaceReady={onWorkspaceReady} />)
    fireEvent.click(screen.getByRole('button', { name: 'Criar workspace local' }))

    await waitFor(() =>
      expect(onWorkspaceReady).toHaveBeenCalledWith({
        id: 'workspace-1',
        name: 'Workspace',
        rootPath: '/home/user/Documents/Alcy Workspaces/Workspace',
      }),
    )
    expect(createWorkspace).toHaveBeenCalledWith({ id: expect.any(String) })
    expect(pickWorkspaceFolder).not.toHaveBeenCalled()
  })

  it('mostra a mensagem de erro quando a criação falha', async () => {
    createWorkspace.mockResolvedValue({
      ok: false,
      error: { kind: 'storage', message: 'falha ao escrever arquivo: disco cheio' },
    })

    render(<StartScreen onWorkspaceReady={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Criar workspace local' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Falha ao acessar o workspace: falha ao escrever arquivo: disco cheio',
    )
  })

  it('abre um workspace existente escolhendo uma pasta', async () => {
    pickWorkspaceFolder.mockResolvedValue('/workspaces/existing')
    openWorkspace.mockResolvedValue({
      ok: true,
      value: { id: 'workspace-1', name: 'existing', rootPath: '/workspaces/existing' },
    })
    const onWorkspaceReady = vi.fn()

    render(<StartScreen onWorkspaceReady={onWorkspaceReady} />)
    fireEvent.click(screen.getByRole('button', { name: 'Abrir workspace existente' }))

    await waitFor(() =>
      expect(onWorkspaceReady).toHaveBeenCalledWith({ id: 'workspace-1', name: 'existing', rootPath: '/workspaces/existing' }),
    )
  })

  it('mostra a mensagem de erro quando a pasta escolhida não é um workspace', async () => {
    pickWorkspaceFolder.mockResolvedValue('/workspaces/not-a-workspace')
    openWorkspace.mockResolvedValue({
      ok: false,
      error: { kind: 'notAWorkspace', message: 'nenhum workspace em /workspaces/not-a-workspace' },
    })

    render(<StartScreen onWorkspaceReady={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Abrir workspace existente' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Esta pasta não contém um workspace Alcy.')
  })

  it('lista e reabre um workspace recente sem abrir o diálogo de pasta', async () => {
    listRecentWorkspaces.mockResolvedValue({
      ok: true,
      value: [{ rootPath: '/workspaces/my-api', name: 'my-api' }],
    })
    openWorkspace.mockResolvedValue({
      ok: true,
      value: { id: 'workspace-1', name: 'my-api', rootPath: '/workspaces/my-api' },
    })
    const onWorkspaceReady = vi.fn()

    render(<StartScreen onWorkspaceReady={onWorkspaceReady} />)

    const recentButton = await screen.findByRole('button', { name: 'Abrir workspace my-api' })
    fireEvent.click(recentButton)

    await waitFor(() => expect(openWorkspace).toHaveBeenCalledWith({ rootPath: '/workspaces/my-api' }))
    expect(pickWorkspaceFolder).not.toHaveBeenCalled()
    expect(onWorkspaceReady).toHaveBeenCalledWith({ id: 'workspace-1', name: 'my-api', rootPath: '/workspaces/my-api' })
  })
})
