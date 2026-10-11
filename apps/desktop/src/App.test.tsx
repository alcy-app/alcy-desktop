import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { registerBeforeExit } from './shared/app-lifecycle/before-exit'
import App from './App'

const listRecentWorkspaces = vi.fn()
const createWorkspace = vi.fn()
const openWorkspace = vi.fn()
const removeWorkspace = vi.fn()
const listEnvironments = vi.fn()
const listCollections = vi.fn()
const onWindowCloseRequested = vi.fn()

vi.mock('./bindings/list-recent-workspaces', () => ({
  listRecentWorkspaces: (...args: unknown[]) => listRecentWorkspaces(...args),
}))

vi.mock('./bindings/create-workspace', () => ({
  createWorkspace: (...args: unknown[]) => createWorkspace(...args),
}))

vi.mock('./bindings/open-workspace', () => ({
  openWorkspace: (...args: unknown[]) => openWorkspace(...args),
}))

vi.mock('./bindings/remove-workspace', () => ({
  removeWorkspace: (...args: unknown[]) => removeWorkspace(...args),
}))

vi.mock('./bindings/list-environments', () => ({
  listEnvironments: (...args: unknown[]) => listEnvironments(...args),
}))

vi.mock('./bindings/list-collections', () => ({
  listCollections: (...args: unknown[]) => listCollections(...args),
}))

vi.mock('./bindings/on-window-close-requested', () => ({
  onWindowCloseRequested: (...args: unknown[]) => onWindowCloseRequested(...args),
}))

beforeEach(() => {
  listRecentWorkspaces.mockReset()
  createWorkspace.mockReset()
  openWorkspace.mockReset()
  removeWorkspace.mockReset()
  listEnvironments.mockReset()
  listCollections.mockReset()
  onWindowCloseRequested.mockReset()
  listRecentWorkspaces.mockResolvedValue({ ok: true, value: [] })
  listEnvironments.mockResolvedValue({ ok: true, value: { environments: [], activeEnvironmentId: null, unreadableSecrets: [] } })
  listCollections.mockResolvedValue({ ok: true, value: [] })
  onWindowCloseRequested.mockResolvedValue(() => {})
})

describe('App', () => {
  it('mostra a tela inicial quando não há nenhum workspace recente', async () => {
    render(<App />)

    expect(await screen.findByRole('button', { name: 'Criar workspace local' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Alcy' })).toBeInTheDocument()
  })

  it('centraliza o fechamento da janela e aguarda os trabalhos registrados', async () => {
    const beforeExit = vi.fn()
    const unregister = registerBeforeExit(beforeExit)

    render(<App />)

    await waitFor(() => expect(onWindowCloseRequested).toHaveBeenCalledTimes(1))
    const closeHandler = onWindowCloseRequested.mock.calls[0][0] as () => Promise<void>
    await closeHandler()

    expect(beforeExit).toHaveBeenCalledTimes(1)
    unregister()
  })

  it('mostra o workbench depois que um workspace é criado', async () => {
    createWorkspace.mockResolvedValue({
      ok: true,
      value: { id: 'workspace-1', name: 'Workspace', rootPath: '/home/user/Documents/Alcy Workspaces/Workspace' },
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Criar workspace local' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Nova requisição GraphQL' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Criar workspace local' })).not.toBeInTheDocument()
  })

  it('reabre automaticamente o workspace usado mais recentemente', async () => {
    listRecentWorkspaces.mockResolvedValue({
      ok: true,
      value: [{ rootPath: '/workspaces/a', name: 'A' }],
    })
    openWorkspace.mockResolvedValue({
      ok: true,
      value: { id: 'workspace-a', name: 'A', rootPath: '/workspaces/a' },
    })

    render(<App />)

    expect(await screen.findByRole('button', { name: 'Nova requisição GraphQL' })).toBeInTheDocument()
    expect(openWorkspace).toHaveBeenCalledWith({ rootPath: '/workspaces/a' })
    expect(screen.queryByRole('button', { name: 'Criar workspace local' })).not.toBeInTheDocument()
  })

  it('esquece um workspace recente que não abre mais e cai na tela inicial', async () => {
    listRecentWorkspaces.mockResolvedValue({
      ok: true,
      value: [{ rootPath: '/workspaces/missing', name: 'Sumido' }],
    })
    openWorkspace.mockResolvedValue({
      ok: false,
      error: { kind: 'notAWorkspace', message: 'pasta não encontrada' },
    })
    removeWorkspace.mockResolvedValue({ ok: true, value: [] })

    render(<App />)

    expect(await screen.findByRole('button', { name: 'Criar workspace local' })).toBeInTheDocument()
    expect(removeWorkspace).toHaveBeenCalledWith({ rootPath: '/workspaces/missing', deleteFiles: false })
  })
})
