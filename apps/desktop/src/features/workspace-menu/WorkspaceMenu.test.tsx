import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '../../test-utils'
import { WorkspaceMenu } from './WorkspaceMenu'

const createWorkspace = vi.fn()
const openWorkspace = vi.fn()
const listRecentWorkspaces = vi.fn()
const pickWorkspaceFolder = vi.fn()
const removeWorkspace = vi.fn()
const renameWorkspace = vi.fn()

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

vi.mock('../../bindings/remove-workspace', () => ({
  removeWorkspace: (...args: unknown[]) => removeWorkspace(...args),
}))

vi.mock('../../bindings/rename-workspace', () => ({
  renameWorkspace: (...args: unknown[]) => renameWorkspace(...args),
}))

const currentWorkspace = { id: 'workspace-1', name: 'Current', rootPath: '/workspaces/current' }

beforeEach(() => {
  createWorkspace.mockReset()
  openWorkspace.mockReset()
  listRecentWorkspaces.mockReset()
  pickWorkspaceFolder.mockReset()
  removeWorkspace.mockReset()
  renameWorkspace.mockReset()
  listRecentWorkspaces.mockResolvedValue({ ok: true, value: [{ rootPath: currentWorkspace.rootPath, name: 'Current' }] })
})

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /Current/ }))
}

describe('WorkspaceMenu', () => {
  it('identifica workspaces locais e vinculados ao Git remoto', () => {
    const props = { currentWorkspace, onWorkspaceChange: vi.fn(), onExitToStartScreen: vi.fn() }
    const { rerender } = render(<WorkspaceMenu {...props} remoteLinked={false} />)

    expect(screen.getByTitle('privado, somente local')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /privado, somente local/ })).toBeInTheDocument()

    rerender(<WorkspaceMenu {...props} remoteLinked />)

    expect(screen.getByTitle('compartilhado via Git remoto')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /compartilhado via Git remoto/ })).toBeInTheDocument()
  })

  it('abre e lista os workspaces recentes, com o atual em destaque', async () => {
    listRecentWorkspaces.mockResolvedValue({
      ok: true,
      value: [
        { rootPath: currentWorkspace.rootPath, name: 'Current' },
        { rootPath: '/workspaces/other', name: 'Other' },
      ],
    })

    render(
      <WorkspaceMenu currentWorkspace={currentWorkspace} remoteLinked={false} onWorkspaceChange={vi.fn()} onExitToStartScreen={vi.fn()} />,
    )
    openMenu()

    const menu = await screen.findByRole('menu')
    const currentItem = within(menu).getByRole('button', { current: true })
    expect(currentItem).toHaveTextContent('Current')
    expect(within(menu).getByText('/workspaces/other')).toBeInTheDocument()
  })

  it('mostra o símbolo de Git só nos workspaces recentes vinculados a um repositório remoto', async () => {
    listRecentWorkspaces.mockResolvedValue({
      ok: true,
      value: [
        { rootPath: currentWorkspace.rootPath, name: 'Current', linked: true },
        { rootPath: '/workspaces/other', name: 'Other', linked: false },
      ],
    })

    render(
      <WorkspaceMenu currentWorkspace={currentWorkspace} remoteLinked={false} onWorkspaceChange={vi.fn()} onExitToStartScreen={vi.fn()} />,
    )
    openMenu()

    const menu = await screen.findByRole('menu')
    const currentItem = within(menu).getByRole('button', { current: true })
    const otherItem = within(menu).getByText('Other').closest('button')
    expect(otherItem).not.toBeNull()

    expect(within(currentItem).getByTitle('compartilhado via Git remoto')).toBeInTheDocument()
    expect(within(otherItem!).queryByTitle('compartilhado via Git remoto')).not.toBeInTheDocument()
  })

  it('continua aberto ao clicar numa área do menu sem foco próprio', async () => {
    render(
      <WorkspaceMenu currentWorkspace={currentWorkspace} remoteLinked={false} onWorkspaceChange={vi.fn()} onExitToStartScreen={vi.fn()} />,
    )
    openMenu()

    const menu = await screen.findByRole('menu')
    // O navegador leva o foco ao ancestral focável mais próximo do clique.
    menu.focus()

    expect(document.activeElement).toBe(menu)
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('troca para outro workspace recente', async () => {
    listRecentWorkspaces.mockResolvedValue({
      ok: true,
      value: [
        { rootPath: currentWorkspace.rootPath, name: 'Current' },
        { rootPath: '/workspaces/other', name: 'Other' },
      ],
    })
    openWorkspace.mockResolvedValue({ ok: true, value: { id: 'workspace-2', name: 'Other', rootPath: '/workspaces/other' } })
    const onWorkspaceChange = vi.fn()

    render(
      <WorkspaceMenu
        currentWorkspace={currentWorkspace}
        remoteLinked={false}
        onWorkspaceChange={onWorkspaceChange}
        onExitToStartScreen={vi.fn()}
      />,
    )
    openMenu()

    const menu = await screen.findByRole('menu')
    fireEvent.click(within(menu).getByText('Other'))

    await waitFor(() => expect(openWorkspace).toHaveBeenCalledWith({ rootPath: '/workspaces/other' }))
    expect(onWorkspaceChange).toHaveBeenCalledWith({ id: 'workspace-2', name: 'Other', rootPath: '/workspaces/other' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('cria um novo workspace pelo menu', async () => {
    createWorkspace.mockResolvedValue({ ok: true, value: { id: 'workspace-new', name: 'Workspace 2', rootPath: '/workspaces/new' } })
    const onWorkspaceChange = vi.fn()

    render(
      <WorkspaceMenu
        currentWorkspace={currentWorkspace}
        remoteLinked={false}
        onWorkspaceChange={onWorkspaceChange}
        onExitToStartScreen={vi.fn()}
      />,
    )
    openMenu()

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Criar novo workspace' }))

    await waitFor(() =>
      expect(onWorkspaceChange).toHaveBeenCalledWith({ id: 'workspace-new', name: 'Workspace 2', rootPath: '/workspaces/new' }),
    )
  })

  it('importa um workspace escolhendo uma pasta existente', async () => {
    pickWorkspaceFolder.mockResolvedValue('/workspaces/imported')
    openWorkspace.mockResolvedValue({
      ok: true,
      value: { id: 'workspace-imported', name: 'imported', rootPath: '/workspaces/imported' },
    })
    const onWorkspaceChange = vi.fn()

    render(
      <WorkspaceMenu
        currentWorkspace={currentWorkspace}
        remoteLinked={false}
        onWorkspaceChange={onWorkspaceChange}
        onExitToStartScreen={vi.fn()}
      />,
    )
    openMenu()

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Importar workspace existente' }))

    await waitFor(() =>
      expect(onWorkspaceChange).toHaveBeenCalledWith({
        id: 'workspace-imported',
        name: 'imported',
        rootPath: '/workspaces/imported',
      }),
    )
  })

  it('renomeia o workspace atual e avisa o workbench e o controle de versão', async () => {
    renameWorkspace.mockResolvedValue({ ok: true, value: { ...currentWorkspace, name: 'Payments API' } })
    const onWorkspaceChange = vi.fn()
    const onLocalChange = vi.fn()

    render(
      <WorkspaceMenu
        currentWorkspace={currentWorkspace}
        remoteLinked={false}
        onWorkspaceChange={onWorkspaceChange}
        onExitToStartScreen={vi.fn()}
        onLocalChange={onLocalChange}
      />,
    )
    openMenu()

    fireEvent.click(await screen.findByRole('button', { name: 'Renomear workspace Current' }))
    const input = screen.getByRole('textbox', { name: 'Nome do workspace' })
    expect(input).toHaveValue('Current')
    fireEvent.change(input, { target: { value: '  Payments API  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(renameWorkspace).toHaveBeenCalledWith({ rootPath: currentWorkspace.rootPath, name: 'Payments API' }),
    )
    await waitFor(() => expect(onWorkspaceChange).toHaveBeenCalledWith({ ...currentWorkspace, name: 'Payments API' }))
    expect(onLocalChange).toHaveBeenCalled()
    expect(within(screen.getByRole('menu')).getByText('Payments API')).toBeInTheDocument()
  })

  it('renomeia outro workspace sem trocar o atual', async () => {
    listRecentWorkspaces.mockResolvedValue({
      ok: true,
      value: [
        { rootPath: currentWorkspace.rootPath, name: 'Current' },
        { rootPath: '/workspaces/other', name: 'Other' },
      ],
    })
    renameWorkspace.mockResolvedValue({ ok: true, value: { id: 'workspace-2', name: 'Renamed', rootPath: '/workspaces/other' } })
    const onWorkspaceChange = vi.fn()
    const onLocalChange = vi.fn()

    render(
      <WorkspaceMenu
        currentWorkspace={currentWorkspace}
        remoteLinked={false}
        onWorkspaceChange={onWorkspaceChange}
        onExitToStartScreen={vi.fn()}
        onLocalChange={onLocalChange}
      />,
    )
    openMenu()

    fireEvent.click(await screen.findByRole('button', { name: 'Renomear workspace Other' }))
    const input = screen.getByRole('textbox', { name: 'Nome do workspace' })
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await within(screen.getByRole('menu')).findByText('Renamed')).toBeInTheDocument()
    expect(renameWorkspace).toHaveBeenCalledWith({ rootPath: '/workspaces/other', name: 'Renamed' })
    expect(onWorkspaceChange).not.toHaveBeenCalled()
    expect(onLocalChange).not.toHaveBeenCalled()
  })

  it('confirma o novo nome ao clicar fora do menu, que fecha junto', async () => {
    renameWorkspace.mockResolvedValue({ ok: true, value: { ...currentWorkspace, name: 'Outside' } })

    render(
      <WorkspaceMenu currentWorkspace={currentWorkspace} remoteLinked={false} onWorkspaceChange={vi.fn()} onExitToStartScreen={vi.fn()} />,
    )
    openMenu()

    fireEvent.click(await screen.findByRole('button', { name: 'Renomear workspace Current' }))
    const input = screen.getByRole('textbox', { name: 'Nome do workspace' })
    fireEvent.change(input, { target: { value: 'Outside' } })
    fireEvent.blur(input)

    await waitFor(() => expect(renameWorkspace).toHaveBeenCalledWith({ rootPath: currentWorkspace.rootPath, name: 'Outside' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('não grava nada ao cancelar com Escape, nem com nome vazio', async () => {
    render(
      <WorkspaceMenu currentWorkspace={currentWorkspace} remoteLinked={false} onWorkspaceChange={vi.fn()} onExitToStartScreen={vi.fn()} />,
    )
    openMenu()

    fireEvent.click(await screen.findByRole('button', { name: 'Renomear workspace Current' }))
    let input = screen.getByRole('textbox', { name: 'Nome do workspace' })
    fireEvent.change(input, { target: { value: 'Discarded' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Nome do workspace' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Renomear workspace Current' }))
    input = screen.getByRole('textbox', { name: 'Nome do workspace' })
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(within(screen.getByRole('menu')).getByText('Current')).toBeInTheDocument()
    expect(renameWorkspace).not.toHaveBeenCalled()
  })

  it('pede confirmação antes de remover e apenas esquece o workspace quando essa opção é escolhida', async () => {
    listRecentWorkspaces.mockResolvedValue({
      ok: true,
      value: [
        { rootPath: currentWorkspace.rootPath, name: 'Current' },
        { rootPath: '/workspaces/other', name: 'Other' },
      ],
    })
    removeWorkspace.mockResolvedValue({ ok: true, value: [{ rootPath: currentWorkspace.rootPath, name: 'Current' }] })

    render(
      <WorkspaceMenu currentWorkspace={currentWorkspace} remoteLinked={false} onWorkspaceChange={vi.fn()} onExitToStartScreen={vi.fn()} />,
    )
    openMenu()

    fireEvent.click(await screen.findByRole('button', { name: 'Remover workspace Other' }))

    expect(await screen.findByText('Remover "Other"?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remover apenas da lista' }))

    await waitFor(() =>
      expect(removeWorkspace).toHaveBeenCalledWith({ rootPath: '/workspaces/other', deleteFiles: false }),
    )
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('remove o workspace ativo e sai para a tela inicial quando não sobra nenhum', async () => {
    removeWorkspace.mockResolvedValue({ ok: true, value: [] })
    const onExitToStartScreen = vi.fn()

    render(
      <WorkspaceMenu
        currentWorkspace={currentWorkspace}
        remoteLinked={false}
        onWorkspaceChange={vi.fn()}
        onExitToStartScreen={onExitToStartScreen}
      />,
    )
    openMenu()

    fireEvent.click(await screen.findByRole('button', { name: 'Remover workspace Current' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Apagar também os arquivos' }))

    await waitFor(() =>
      expect(removeWorkspace).toHaveBeenCalledWith({ rootPath: currentWorkspace.rootPath, deleteFiles: true }),
    )
    await waitFor(() => expect(onExitToStartScreen).toHaveBeenCalled())
  })
})
