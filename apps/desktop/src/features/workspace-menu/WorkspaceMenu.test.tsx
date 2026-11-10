import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '../../test-utils'
import { WorkspaceMenu } from './WorkspaceMenu'

const createWorkspace = vi.fn()
const openWorkspace = vi.fn()
const listRecentWorkspaces = vi.fn()
const pickWorkspaceFolder = vi.fn()
const removeWorkspace = vi.fn()
const renameWorkspace = vi.fn()
const renameWorkspaceFolder = vi.fn()
const openWorkspaceFolder = vi.fn()
const runBeforeExit = vi.fn()
const getWorkspaceRemovalOptions = vi.fn()

vi.mock('../../bindings/get-workspace-removal-options', () => ({
  getWorkspaceRemovalOptions: (...args: unknown[]) => getWorkspaceRemovalOptions(...args),
}))

vi.mock('../../bindings/create-workspace', () => ({
  createWorkspace: (...args: unknown[]) => createWorkspace(...args),
}))

vi.mock('../../bindings/open-workspace', () => ({
  openWorkspace: (...args: unknown[]) => openWorkspace(...args),
}))

vi.mock('../../bindings/list-recent-workspaces', () => ({
  listRecentWorkspaces: (...args: unknown[]) => listRecentWorkspaces(...args),
}))

vi.mock('../../bindings/local-git', () => ({
  inspectWorkspaceFolder: async () => ({ ok: true, value: { canCloneAsRemote: false } }),
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

vi.mock('../../bindings/rename-workspace-folder', () => ({
  renameWorkspaceFolder: (...args: unknown[]) => renameWorkspaceFolder(...args),
}))

vi.mock('../../bindings/open-workspace-folder', () => ({
  openWorkspaceFolder: (...args: unknown[]) => openWorkspaceFolder(...args),
}))

vi.mock('../../shared/app-lifecycle/before-exit', () => ({
  runBeforeExit: (...args: unknown[]) => runBeforeExit(...args),
  registerBeforeExit: () => () => undefined,
}))

const currentWorkspace = { id: 'workspace-1', name: 'Current', rootPath: '/workspaces/current' }

beforeEach(() => {
  createWorkspace.mockReset()
  openWorkspace.mockReset()
  listRecentWorkspaces.mockReset()
  pickWorkspaceFolder.mockReset()
  removeWorkspace.mockReset()
  renameWorkspace.mockReset()
  renameWorkspaceFolder.mockReset()
  openWorkspaceFolder.mockReset()
  runBeforeExit.mockReset()
  runBeforeExit.mockResolvedValue(undefined)
  getWorkspaceRemovalOptions.mockReset()
  getWorkspaceRemovalOptions.mockResolvedValue({ ok: true, value: { canDeleteFiles: true, ownerName: null } })
  listRecentWorkspaces.mockResolvedValue({ ok: true, value: [{ rootPath: currentWorkspace.rootPath, name: 'Current' }] })
})

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /Current/ }))
}

async function chooseRenameTarget(workspaceName: string, target: 'Alias' | 'Nome da pasta') {
  fireEvent.click(await screen.findByRole('button', { name: `Renomear workspace ${workspaceName}` }))
  fireEvent.click(screen.getByRole('button', { name: target }))
}

function submitRename() {
  fireEvent.click(screen.getByRole('button', { name: 'Renomear' }))
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
    expect(within(menu).getByRole('button', { name: 'Abrir a pasta other no gerenciador de arquivos' })).toHaveTextContent('other')
    expect(within(menu).queryByText('/workspaces/other')).not.toBeInTheDocument()
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
    expect(await screen.findByRole('tab', { name: 'Repositório Git' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Escolher pasta…' }))

    await waitFor(() =>
      expect(onWorkspaceChange).toHaveBeenCalledWith({
        id: 'workspace-imported',
        name: 'imported',
        rootPath: '/workspaces/imported',
      }),
    )
  })

  it('renomeia o alias do workspace atual e avisa o workbench e o controle de versão', async () => {
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

    await chooseRenameTarget('Current', 'Alias')
    const input = screen.getByRole('textbox', { name: 'Novo alias' })
    expect(input).toHaveValue('Current')
    fireEvent.change(input, { target: { value: '  Payments API  ' } })
    submitRename()

    await waitFor(() =>
      expect(renameWorkspace).toHaveBeenCalledWith({ rootPath: currentWorkspace.rootPath, name: 'Payments API' }),
    )
    await waitFor(() => expect(onWorkspaceChange).toHaveBeenCalledWith({ ...currentWorkspace, name: 'Payments API' }))
    expect(onLocalChange).toHaveBeenCalled()
    expect(renameWorkspaceFolder).not.toHaveBeenCalled()
    expect(await within(screen.getByRole('menu')).findByText('Payments API')).toBeInTheDocument()
  })

  it('renomeia o alias de outro workspace sem trocar o atual', async () => {
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

    await chooseRenameTarget('Other', 'Alias')
    fireEvent.change(screen.getByRole('textbox', { name: 'Novo alias' }), { target: { value: 'Renamed' } })
    submitRename()

    expect(await within(screen.getByRole('menu')).findByText('Renamed')).toBeInTheDocument()
    expect(renameWorkspace).toHaveBeenCalledWith({ rootPath: '/workspaces/other', name: 'Renamed' })
    expect(onWorkspaceChange).not.toHaveBeenCalled()
    expect(onLocalChange).not.toHaveBeenCalled()
  })

  it('renomeia a pasta de outro workspace sem recarregar o atual', async () => {
    listRecentWorkspaces.mockResolvedValue({
      ok: true,
      value: [
        { rootPath: currentWorkspace.rootPath, name: 'Current' },
        { rootPath: '/workspaces/other', name: 'Other' },
      ],
    })
    renameWorkspaceFolder.mockResolvedValue({ ok: true, value: { id: 'workspace-2', name: 'Other', rootPath: '/workspaces/payments' } })
    window.localStorage.setItem('alcy:collections:favorites:/workspaces/other', '["c1"]')
    const onWorkspaceChange = vi.fn()

    render(
      <WorkspaceMenu currentWorkspace={currentWorkspace} remoteLinked={false} onWorkspaceChange={onWorkspaceChange} onExitToStartScreen={vi.fn()} />,
    )
    openMenu()

    await chooseRenameTarget('Other', 'Nome da pasta')
    const input = screen.getByRole('textbox', { name: 'Novo nome da pasta' })
    expect(input).toHaveValue('other')
    fireEvent.change(input, { target: { value: ' payments ' } })
    expect(screen.getByText('/workspaces/payments')).toBeInTheDocument()
    submitRename()

    expect(
      await within(screen.getByRole('menu')).findByRole('button', { name: 'Abrir a pasta payments no gerenciador de arquivos' }),
    ).toBeInTheDocument()
    expect(renameWorkspaceFolder).toHaveBeenCalledWith({ rootPath: '/workspaces/other', folderName: 'payments' })
    expect(renameWorkspace).not.toHaveBeenCalled()
    expect(runBeforeExit).not.toHaveBeenCalled()
    expect(onWorkspaceChange).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('alcy:collections:favorites:/workspaces/payments')).toBe('["c1"]')
    expect(window.localStorage.getItem('alcy:collections:favorites:/workspaces/other')).toBeNull()
    window.localStorage.removeItem('alcy:collections:favorites:/workspaces/payments')
  })

  it('salva o que está pendente antes de renomear a pasta do workspace aberto e o recarrega', async () => {
    const order: string[] = []
    runBeforeExit.mockImplementation(async () => {
      order.push('flush')
    })
    renameWorkspaceFolder.mockImplementation(async () => {
      order.push('rename')
      return { ok: true, value: { ...currentWorkspace, rootPath: '/workspaces/renamed' } }
    })
    const onWorkspaceChange = vi.fn()

    render(
      <WorkspaceMenu currentWorkspace={currentWorkspace} remoteLinked={false} onWorkspaceChange={onWorkspaceChange} onExitToStartScreen={vi.fn()} />,
    )
    openMenu()

    await chooseRenameTarget('Current', 'Nome da pasta')
    expect(screen.getByText('Este workspace está aberto e será recarregado na nova pasta.')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Novo nome da pasta' }), { target: { value: 'renamed' } })
    submitRename()

    await waitFor(() => expect(onWorkspaceChange).toHaveBeenCalledWith({ ...currentWorkspace, rootPath: '/workspaces/renamed' }))
    expect(order).toEqual(['flush', 'rename'])
  })

  it('mantém o painel e o nome digitado quando a pasta não pode ser renomeada', async () => {
    renameWorkspaceFolder.mockResolvedValue({ ok: false, error: { kind: 'folderExists', message: 'taken' } })
    const onWorkspaceChange = vi.fn()

    render(
      <WorkspaceMenu currentWorkspace={currentWorkspace} remoteLinked={false} onWorkspaceChange={onWorkspaceChange} onExitToStartScreen={vi.fn()} />,
    )
    openMenu()

    await chooseRenameTarget('Current', 'Nome da pasta')
    const input = screen.getByRole('textbox', { name: 'Novo nome da pasta' })
    fireEvent.change(input, { target: { value: 'taken' } })
    submitRename()

    expect(await screen.findByText('Já existe uma pasta chamada "taken" neste local.')).toBeInTheDocument()
    expect(input).toHaveValue('taken')
    expect(onWorkspaceChange).not.toHaveBeenCalled()
  })

  it('volta um passo com Escape sem fechar o menu e não grava nada', async () => {
    render(
      <WorkspaceMenu currentWorkspace={currentWorkspace} remoteLinked={false} onWorkspaceChange={vi.fn()} onExitToStartScreen={vi.fn()} />,
    )
    openMenu()

    await chooseRenameTarget('Current', 'Alias')
    const input = screen.getByRole('textbox', { name: 'Novo alias' })
    fireEvent.change(input, { target: { value: 'Discarded' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    const aliasOption = screen.getByRole('button', { name: 'Alias' })
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    fireEvent.keyDown(aliasOption, { key: 'Escape' })

    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Alias' })).not.toBeInTheDocument()
    expect(within(screen.getByRole('menu')).getByText('Current')).toBeInTheDocument()
    expect(renameWorkspace).not.toHaveBeenCalled()
  })

  it('só habilita Renomear quando o nome mudou e não está vazio', async () => {
    render(
      <WorkspaceMenu currentWorkspace={currentWorkspace} remoteLinked={false} onWorkspaceChange={vi.fn()} onExitToStartScreen={vi.fn()} />,
    )
    openMenu()

    await chooseRenameTarget('Current', 'Alias')
    const submit = screen.getByRole('button', { name: 'Renomear' })
    expect(submit).toBeDisabled()

    const input = screen.getByRole('textbox', { name: 'Novo alias' })
    fireEvent.change(input, { target: { value: '   ' } })
    expect(submit).toBeDisabled()

    fireEvent.change(input, { target: { value: 'Other' } })
    expect(submit).toBeEnabled()
  })

  it('abre a pasta do workspace ao clicar no nome dela, sem trocar de workspace', async () => {
    openWorkspaceFolder.mockResolvedValue({ ok: true })

    render(
      <WorkspaceMenu currentWorkspace={currentWorkspace} remoteLinked={false} onWorkspaceChange={vi.fn()} onExitToStartScreen={vi.fn()} />,
    )
    openMenu()

    fireEvent.click(await screen.findByRole('button', { name: 'Abrir a pasta current no gerenciador de arquivos' }))

    await waitFor(() => expect(openWorkspaceFolder).toHaveBeenCalledWith({ rootPath: currentWorkspace.rootPath }))
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(openWorkspace).not.toHaveBeenCalled()
  })

  it('mostra o erro e continua aberto quando a pasta não pode ser aberta', async () => {
    openWorkspaceFolder.mockResolvedValue({ ok: false, error: { kind: 'notAWorkspace', message: '/workspaces/current' } })

    render(
      <WorkspaceMenu currentWorkspace={currentWorkspace} remoteLinked={false} onWorkspaceChange={vi.fn()} onExitToStartScreen={vi.fn()} />,
    )
    openMenu()

    fireEvent.click(await screen.findByRole('button', { name: 'Abrir a pasta current no gerenciador de arquivos' }))

    expect(await screen.findByText('Esta pasta não contém um workspace Alcy.')).toBeInTheDocument()
    expect(screen.getByRole('menu')).toBeInTheDocument()
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

  function renderAndAskToRemoveCurrent() {
    render(
      <WorkspaceMenu currentWorkspace={currentWorkspace} remoteLinked={false} onWorkspaceChange={vi.fn()} onExitToStartScreen={vi.fn()} />,
    )
    openMenu()
    return screen.findByRole('button', { name: 'Remover workspace Current' }).then((button) => fireEvent.click(button))
  }

  it('só oferece remover da lista a quem não é o dono do repositório', async () => {
    getWorkspaceRemovalOptions.mockResolvedValue({ ok: true, value: { canDeleteFiles: false, ownerName: 'Ana' } })
    removeWorkspace.mockResolvedValue({ ok: true, value: [] })

    await renderAndAskToRemoveCurrent()

    expect(await screen.findByText(/Só Ana, quem iniciou o Git/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apagar também os arquivos' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remover apenas da lista' }))

    await waitFor(() =>
      expect(removeWorkspace).toHaveBeenCalledWith({ rootPath: currentWorkspace.rootPath, deleteFiles: false }),
    )
  })

  it('não deixa apagar os arquivos enquanto verifica o dono', async () => {
    getWorkspaceRemovalOptions.mockReturnValue(new Promise(() => {}))

    await renderAndAskToRemoveCurrent()

    expect(await screen.findByRole('button', { name: 'Apagar também os arquivos' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remover apenas da lista' })).toBeEnabled()
  })

  it('mantém os arquivos quando não consegue verificar o dono', async () => {
    getWorkspaceRemovalOptions.mockResolvedValue({ ok: false, error: { kind: 'storage', message: 'broken' } })

    await renderAndAskToRemoveCurrent()

    expect(await screen.findByText(/Não foi possível confirmar quem iniciou o Git/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apagar também os arquivos' })).not.toBeInTheDocument()
  })
})
