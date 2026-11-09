import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '../../test-utils'
import type { ChangedItemDto, FileStatusDto, WorkspaceLinkDto } from '../../bindings/version-control-types'
import type { GitStateDto } from '../../bindings/local-git'
import { useVersionControl } from './use-version-control'
import { VersionControlPanel, type VersionReviewTarget } from './VersionControlPanel'
import { VersionReview } from './VersionReview'

const getWorkspaceLink = vi.fn()
const getVersionStatus = vi.fn()
const getLocalVersionStatus = vi.fn()
const linkWorkspace = vi.fn()
const commitAndPush = vi.fn()
const getStructuredFileChanges = vi.fn()
const cancelVersionControlOperation = vi.fn()
const pickWorkspaceFolder = vi.fn()
const git = vi.hoisted(() => ({
  getGitState: vi.fn(),
  createGitBranch: vi.fn(),
  switchGitBranch: vi.fn(),
  deleteGitBranch: vi.fn(),
  mergeGitBranch: vi.fn(),
  finishGitMerge: vi.fn(),
  abortGitMerge: vi.fn(),
  getGitHistory: vi.fn(),
  getGitCommitChanges: vi.fn(),
  restoreGitFile: vi.fn(),
  setGitRemote: vi.fn(),
  fetchGitRemote: vi.fn(),
  pullGitRemote: vi.fn(),
  pushGitRemote: vi.fn(),
  getGitIdentity: vi.fn(),
}))

vi.mock('../../shared/feature-flags', () => ({ FEATURE_FLAGS: { localGit: true } }))
vi.mock('../../bindings/get-workspace-link', () => ({ getWorkspaceLink: (...a: unknown[]) => getWorkspaceLink(...a) }))
vi.mock('../../bindings/get-version-status', () => ({ getVersionStatus: (...a: unknown[]) => getVersionStatus(...a) }))
vi.mock('../../bindings/get-local-version-status', () => ({ getLocalVersionStatus: (...a: unknown[]) => getLocalVersionStatus(...a) }))
vi.mock('../../bindings/link-workspace', () => ({ linkWorkspace: (...a: unknown[]) => linkWorkspace(...a) }))
vi.mock('../../bindings/commit-and-push', () => ({ commitAndPush: (...a: unknown[]) => commitAndPush(...a) }))
vi.mock('../../bindings/get-structured-file-changes', () => ({ getStructuredFileChanges: (...a: unknown[]) => getStructuredFileChanges(...a) }))
vi.mock('../../bindings/cancel-version-control-operation', () => ({ cancelVersionControlOperation: (...a: unknown[]) => cancelVersionControlOperation(...a) }))
vi.mock('../../bindings/pick-workspace-folder', () => ({ pickWorkspaceFolder: (...a: unknown[]) => pickWorkspaceFolder(...a) }))
vi.mock('../../bindings/local-git', () => Object.fromEntries(
  Object.keys(git).map((name) => [name, (...a: unknown[]) => git[name as keyof typeof git](...a)]),
))

const ROOT = '/work/space'
const COLLECTIONS = 'alcy-collections.json'
const URL = 'git@example.com:team/api.git'
const link: WorkspaceLinkDto = { includeEnvironments: false }
const status = (files: FileStatusDto[], current: WorkspaceLinkDto = link) => ({ ok: true, value: { link: current, files } })
const state = (overrides: Partial<GitStateDto> = {}) => ({
  ok: true,
  value: { branch: 'main', branches: ['feature', 'main'], hasCommits: true, merge: null, remote: null, tracking: null, ...overrides },
})
const changed: FileStatusDto = { name: COLLECTIONS, state: 'localModified', localRevision: 'l', remoteRevision: 'r' }
const conflict: FileStatusDto = { name: COLLECTIONS, state: 'conflict', localRevision: 'l', remoteRevision: 'r' }
const onFilesChanged = vi.fn()
const onOpenSettings = vi.fn()

function Harness({ onReview }: { onReview?: (target: VersionReviewTarget) => void }) {
  const vc = useVersionControl(ROOT, onFilesChanged)
  return <VersionControlPanel rootPath={ROOT} vc={vc} onOpenSettings={onOpenSettings} onReview={onReview} onPull={() => {}} onResolveConflict={() => {}} embedded />
}

const commit = (id: string, summary: string, refs: string[] = []) => ({
  id, authorName: 'Ana', authorEmail: 'ana@example.com', time: 1_700_000_000, summary, files: [COLLECTIONS], parents: [], refs,
})
const openMenu = async () => {
  // The git menu replaces the generic one once the git state has loaded.
  await waitFor(() => expect(document.querySelector('.vc-git-branch-host, .vc-git-branch-label')).not.toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Mais ações do repositório' }))
}
const chooseAction = async (name: string) => {
  await openMenu()
  fireEvent.click(await screen.findByRole('menuitem', { name }))
}
const panelHeader = async () => within(await waitFor(() => {
  const element = document.querySelector<HTMLElement>('.vc-repository-actions')
  expect(element).not.toBeNull()
  return element!
}))

beforeEach(() => {
  for (const mock of [getWorkspaceLink, getVersionStatus, getLocalVersionStatus, linkWorkspace, commitAndPush, getStructuredFileChanges, cancelVersionControlOperation, pickWorkspaceFolder, onFilesChanged, onOpenSettings, ...Object.values(git)]) {
    mock.mockReset()
  }
  getWorkspaceLink.mockResolvedValue({ ok: true, value: link })
  getLocalVersionStatus.mockResolvedValue({ ok: true, value: [] })
  getVersionStatus.mockResolvedValue(status([]))
  getStructuredFileChanges.mockImplementation((_root: string, _operation: string, name: string) => Promise.resolve({
    ok: true,
    value: { name, localRevision: 'local', remoteRevision: 'remote', supportsPartial: false, items: [] },
  }))
  git.getGitState.mockResolvedValue(state())
  git.getGitHistory.mockResolvedValue({ ok: true, value: { commits: [], nextOffset: null } })
  git.getGitIdentity.mockResolvedValue({
    ok: true,
    value: { system: { name: 'Ana Lima', email: 'ana@example.com' }, overrides: { name: null, email: null }, effective: { name: 'Ana Lima', email: 'ana@example.com' } },
  })
})

describe('git in the workspace — starting', () => {
  beforeEach(() => {
    getWorkspaceLink.mockResolvedValue({ ok: true, value: null })
  })

  it('offers only starting git, without any account', async () => {
    linkWorkspace.mockResolvedValue(status([]))
    render(<Harness />)

    expect(await screen.findByText(/Este workspace ainda não usa Git/)).toBeInTheDocument()
    expect(screen.queryByText('Nenhuma conta conectada')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar Git' }))

    await waitFor(() => expect(linkWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      rootPath: ROOT, includeEnvironments: false,
    })))
    expect(git.pullGitRemote).not.toHaveBeenCalled()
  })
})

describe('git in the workspace — branches', () => {
  it('commits with a message and switches branches, reloading the rewritten files', async () => {
    git.switchGitBranch.mockResolvedValue({ ok: true, value: { files: [COLLECTIONS] } })
    render(<Harness />)

    const branch = await screen.findByRole('button', { name: 'Branch: main' })
    expect(screen.getByRole('button', { name: 'Commit' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Mensagem do commit' })).toBeInTheDocument()

    fireEvent.click(branch)
    expect(await screen.findByRole('menuitemradio', { name: 'main' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'feature' }))
    await waitFor(() => expect(git.switchGitBranch).toHaveBeenCalledWith(ROOT, 'feature'))
    await waitFor(() => expect(onFilesChanged).toHaveBeenCalledWith([COLLECTIONS]))
  })

  it('creates, merges and deletes branches', async () => {
    git.createGitBranch.mockResolvedValue({ ok: true, value: { files: [] } })
    git.mergeGitBranch.mockResolvedValue({ ok: true, value: { outcome: 'merged', conflicts: [], files: [COLLECTIONS] } })
    git.deleteGitBranch.mockResolvedValue({ ok: true, value: null })
    render(<Harness />)

    await chooseAction('Nova branch')
    const nameInput = screen.getByRole('textbox', { name: 'Nome da branch' })
    // Suggested from the git user and today's date.
    await waitFor(() => expect((nameInput as HTMLInputElement).value).toMatch(/^ana-lima-\d{4}-\d{2}-\d{2}$/))
    fireEvent.change(nameInput, { target: { value: 'Teste Login' } })
    expect(screen.getByText('Será criada como teste-login.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }))
    await waitFor(() => expect(git.createGitBranch).toHaveBeenCalledWith(ROOT, 'teste-login', true))

    await chooseAction('Mesclar uma branch')
    fireEvent.click(await screen.findByRole('button', { name: 'Mesclar em main' }))
    await waitFor(() => expect(git.mergeGitBranch).toHaveBeenCalledWith(ROOT, 'feature'))
    expect(onFilesChanged).toHaveBeenCalledWith([COLLECTIONS])

    await chooseAction('Excluir uma branch')
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/Excluir a branch feature\?/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }))
    await waitFor(() => expect(git.deleteGitBranch).toHaveBeenCalledWith(ROOT, 'feature'))
  })

  it('chooses the branch to merge from its menu, and Escape closes only the menu', async () => {
    git.getGitState.mockResolvedValue(state({ branches: ['feature', 'hotfix', 'main'] }))
    git.mergeGitBranch.mockResolvedValue({ ok: true, value: { outcome: 'merged', conflicts: [], files: [] } })
    render(<Harness />)

    await chooseAction('Mesclar uma branch')
    fireEvent.click(await screen.findByRole('button', { name: 'Mesclar uma branch: feature' }))
    expect(await screen.findByRole('menuitemradio', { name: 'hotfix' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menuitemradio', { name: 'hotfix' })).not.toBeInTheDocument())
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Mesclar uma branch: feature' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'hotfix' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mesclar em main' }))
    await waitFor(() => expect(git.mergeGitBranch).toHaveBeenCalledWith(ROOT, 'hotfix'))
  })

  it('asks for the first commit before creating branches', async () => {
    git.getGitState.mockResolvedValue(state({ hasCommits: false, branches: [] }))
    render(<Harness />)

    await openMenu()
    expect(await screen.findByRole('menuitem', { name: 'Nova branch' })).toBeDisabled()
  })
})

describe('git in the workspace — pending merge', () => {
  it('replaces the commit with finishing the merge once conflicts are resolved', async () => {
    git.getGitState.mockResolvedValue(state({ remote: URL, merge: { label: 'Bia', conflicts: [COLLECTIONS] } }))
    getVersionStatus.mockResolvedValue(status([conflict]))
    git.finishGitMerge.mockResolvedValue({ ok: true, value: { commitId: 'abc' } })
    render(<Harness />)

    expect(await screen.findByText('Mesclando alterações de Bia')).toBeInTheDocument()
    expect(await screen.findByText('1 arquivo(s) com conflito: resolva abaixo.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Commit' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Concluir mesclagem' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Branch: main' })).not.toBeInTheDocument()
    expect(screen.getByText('main')).toBeInTheDocument()

    getVersionStatus.mockResolvedValue(status([changed]))
    fireEvent.click(screen.getByRole('button', { name: 'Verificar' }))
    const finish = screen.getByRole('button', { name: 'Concluir mesclagem' })
    await waitFor(() => expect(finish).toBeEnabled())
    fireEvent.click(finish)
    await waitFor(() => expect(git.finishGitMerge).toHaveBeenCalledWith(ROOT, ''))
  })

  it('cancels the merge after confirmation', async () => {
    git.getGitState.mockResolvedValue(state({ merge: { label: 'feature', conflicts: [COLLECTIONS] } }))
    git.abortGitMerge.mockResolvedValue({ ok: true, value: { files: [COLLECTIONS] } })
    render(<Harness />)

    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar mesclagem' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar mesclagem' }))
    await waitFor(() => expect(git.abortGitMerge).toHaveBeenCalledWith(ROOT))
    await waitFor(() => expect(onFilesChanged).toHaveBeenCalledWith([COLLECTIONS]))
  })
})

describe('git in the workspace — remote', () => {
  it('adds the remote from the menu and offers no remote actions before it', async () => {
    git.setGitRemote.mockResolvedValue({ ok: true, value: { url: URL } })
    render(<Harness />)

    await openMenu()
    expect(await screen.findByRole('menuitem', { name: 'Pull' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Push' })).toBeDisabled()
    expect(screen.queryByRole('menuitem', { name: 'Remover remoto' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar remoto…' }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'URL do remoto' }), { target: { value: ` ${URL} ` } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(git.setGitRemote).toHaveBeenCalledWith(ROOT, URL))
  })

  it('fetches, pulls and pushes from the graph, showing how far the branch is', async () => {
    git.getGitState.mockResolvedValue(state({ remote: URL, tracking: { ahead: 2, behind: 1 } }))
    git.fetchGitRemote.mockResolvedValue({ ok: true, value: null })
    git.pullGitRemote.mockResolvedValue({ ok: true, value: { outcome: 'merged', conflicts: [], files: [COLLECTIONS] } })
    git.pushGitRemote.mockResolvedValue({ ok: true, value: null })
    render(<Harness />)

    fireEvent.click(await screen.findByRole('button', { name: 'Fetch' }))
    await waitFor(() => expect(git.fetchGitRemote).toHaveBeenCalledWith(ROOT, expect.any(String)))

    const pull = await screen.findByRole('button', { name: 'Pull (1)' })
    await waitFor(() => expect(pull).toBeEnabled())
    fireEvent.click(pull)
    await waitFor(() => expect(git.pullGitRemote).toHaveBeenCalledWith(ROOT, expect.any(String)))
    await waitFor(() => expect(onFilesChanged).toHaveBeenCalledWith([COLLECTIONS]))

    const push = await screen.findByRole('button', { name: 'Push (2)' })
    await waitFor(() => expect(push).toBeEnabled())
    fireEvent.click(push)
    await waitFor(() => expect(git.pushGitRemote).toHaveBeenCalledWith(ROOT, expect.any(String)))
  })

  it('shows only the add-remote button in the header without a remote', async () => {
    git.getGitState.mockResolvedValue(state({ hasCommits: false, branches: [] }))
    git.setGitRemote.mockResolvedValue({ ok: true, value: { url: URL } })
    render(<Harness />)

    const header = await panelHeader()
    const add = await header.findByRole('button', { name: 'Adicionar remoto…' })
    for (const name of ['Verificar', 'Pull', 'Push']) expect(header.queryByRole('button', { name })).not.toBeInTheDocument()

    fireEvent.click(add)
    const dialog = await screen.findByRole('dialog', { name: 'Adicionar remoto…' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'URL do remoto' }), { target: { value: URL } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(git.setGitRemote).toHaveBeenCalledWith(ROOT, URL))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('tells to pull when the push is rejected', async () => {
    git.getGitState.mockResolvedValue(state({ remote: URL }))
    git.pushGitRemote.mockResolvedValue({ ok: false, error: { kind: 'gitPushRejected' } })
    render(<Harness />)

    fireEvent.click(await screen.findByRole('button', { name: 'Push' }))
    expect(await screen.findByText(/Faça pull e envie de novo/)).toBeInTheDocument()
  })

  it('changes and removes the remote, and locks remote actions during a merge', async () => {
    git.getGitState.mockResolvedValue(state({ remote: URL, merge: { label: 'origin/main', conflicts: [COLLECTIONS] } }))
    git.setGitRemote.mockResolvedValue({ ok: true, value: { url: null } })
    render(<Harness />)

    expect(await screen.findByRole('button', { name: 'Pull' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Push' })).toBeDisabled()
    await chooseAction('Alterar remoto…')
    expect(await screen.findByRole('textbox', { name: 'URL do remoto' })).toHaveValue(URL)
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancelar' }).at(-1)!)

    await chooseAction('Remover remoto')
    const dialog = await screen.findByRole('dialog', { name: 'Remover remoto' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover remoto' }))
    await waitFor(() => expect(git.setGitRemote).toHaveBeenCalledWith(ROOT, null))
  })
})

describe('git in the workspace — history', () => {
  it('pages, opens a commit per item and restores a file', async () => {
    git.getGitHistory
      .mockResolvedValueOnce({ ok: true, value: { commits: [commit('a'.repeat(40), 'Merge changes from Bia', ['main', 'origin/main'])], nextOffset: 1 } })
      .mockResolvedValueOnce({ ok: true, value: { commits: [commit('b'.repeat(40), 'Initial workspace')], nextOffset: null } })
    git.getGitCommitChanges.mockResolvedValue({
      ok: true,
      value: {
        name: COLLECTIONS, localRevision: 'x', remoteRevision: 'y', supportsPartial: true,
        items: [{ id: 'request:r1', parentId: null, label: 'Login', itemKind: 'request', changeKind: 'modified', fields: [], dependencies: [] }],
      },
    })
    git.restoreGitFile.mockResolvedValue({ ok: true, value: { files: [COLLECTIONS] } })
    render(<Harness />)

    expect(await screen.findByText('Merge changes from Bia')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Grafo' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('origin/main')).toBeInTheDocument()
    expect(git.getGitHistory).toHaveBeenLastCalledWith(ROOT, expect.any(String), 0)

    fireEvent.click(screen.getByRole('button', { name: 'Carregar commits anteriores' }))
    expect(await screen.findByText('Initial workspace')).toBeInTheDocument()
    expect(git.getGitHistory).toHaveBeenLastCalledWith(ROOT, expect.any(String), 1)

    fireEvent.click(screen.getByText('Initial workspace'))
    fireEvent.click(await screen.findByRole('button', { name: 'Coleções' }))
    expect(await screen.findByText('Login')).toBeInTheDocument()
    expect(git.getGitCommitChanges).toHaveBeenCalledWith(ROOT, 'b'.repeat(40), COLLECTIONS)

    fireEvent.click(screen.getByRole('button', { name: 'Restaurar esta versão' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restaurar esta versão' }))
    await waitFor(() => expect(git.restoreGitFile).toHaveBeenCalledWith(ROOT, 'b'.repeat(40), COLLECTIONS))
    await waitFor(() => expect(onFilesChanged).toHaveBeenCalledWith([COLLECTIONS]))
  })
})

describe('git in the workspace — commit details', () => {
  const item: ChangedItemDto = { id: 'request:r1', parentId: null, label: 'Login', itemKind: 'request', changeKind: 'modified', fields: [{ name: 'url', remote: '/old', local: '/new' }], dependencies: [] }
  const changes = { name: COLLECTIONS, localRevision: 'x', remoteRevision: 'y', supportsPartial: true, items: [item] }

  it('opens what an item changed in a past commit', async () => {
    const onReview = vi.fn()
    git.getGitHistory.mockResolvedValue({ ok: true, value: { commits: [commit('c'.repeat(40), 'Edit login')], nextOffset: null } })
    git.getGitCommitChanges.mockResolvedValue({ ok: true, value: changes })
    render(<Harness onReview={onReview} />)

    fireEvent.click(await screen.findByText('Edit login'))
    fireEvent.click(await screen.findByRole('button', { name: 'Coleções' }))
    fireEvent.click(await screen.findByRole('button', { name: /Login/ }))

    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ fileName: COLLECTIONS, item, changes, historical: true }))
  })

  it('compares a past commit with its parent, without the working copy tab', () => {
    render(<VersionReview rootPath={ROOT} target={{ fileName: COLLECTIONS, fileLabel: 'Coleções', changes, item, historical: true }} />)

    expect(screen.getByText('Antes')).toBeInTheDocument()
    expect(screen.getByText('Depois')).toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.getByText('/old')).toBeInTheDocument()
    expect(screen.getByText('/new')).toBeInTheDocument()
  })
})

describe('git in the workspace — author', () => {
  it('commits without a status message', async () => {
    getVersionStatus.mockResolvedValue(status([changed]))
    getLocalVersionStatus.mockResolvedValue({ ok: true, value: [changed] })
    commitAndPush.mockResolvedValue({ ok: true, value: { pushed: [COLLECTIONS] } })
    render(<Harness />)

    fireEvent.click(await screen.findByRole('button', { name: `Preparar todo o arquivo ${COLLECTIONS}` }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Mensagem do commit' }), { target: { value: 'Update' } })
    const commitButton = screen.getByRole('button', { name: 'Commit' })
    await waitFor(() => expect(commitButton).toBeEnabled())
    fireEvent.click(commitButton)

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Mensagem do commit' })).toHaveValue(''))
    expect(screen.queryByText(/Enviado/)).not.toBeInTheDocument()
  })

  it('points to the git settings when no author is configured', async () => {
    getVersionStatus.mockResolvedValue(status([changed]))
    getLocalVersionStatus.mockResolvedValue({ ok: true, value: [changed] })
    commitAndPush.mockResolvedValue({ ok: false, error: { kind: 'gitIdentityMissing' } })
    render(<Harness />)

    fireEvent.click(await screen.findByRole('button', { name: `Preparar todo o arquivo ${COLLECTIONS}` }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Mensagem do commit' }), { target: { value: 'Update' } })
    const commitButton = screen.getByRole('button', { name: 'Commit' })
    await waitFor(() => expect(commitButton).toBeEnabled())
    fireEvent.click(commitButton)

    expect(await screen.findByText(/Não há usuário git para assinar o commit/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Definir usuário git' }))
    expect(onOpenSettings).toHaveBeenCalledWith('git')
  })
})
