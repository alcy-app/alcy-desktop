import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '../../test-utils'
import type { FileStatusDto, WorkspaceLinkDto } from '../../bindings/gitlab-types'
import type { GitStateDto } from '../../bindings/local-git'
import { useVersionControl } from './use-version-control'
import { VersionControlPanel } from './VersionControlPanel'

const getWorkspaceLink = vi.fn()
const getVersionStatus = vi.fn()
const getLocalVersionStatus = vi.fn()
const linkWorkspace = vi.fn()
const commitAndPush = vi.fn()
const getStructuredFileChanges = vi.fn()
const cancelGitlabOperation = vi.fn()
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
  setGitSharedFolder: vi.fn(),
  getGitPeers: vi.fn(),
  syncGitSharedFolder: vi.fn(),
  getGitIdentity: vi.fn(),
}))

vi.mock('../../shared/feature-flags', () => ({ FEATURE_FLAGS: { gitlab: false, onedrive: false, localGit: true } }))
vi.mock('../../bindings/list-gitlab-accounts', () => ({ listGitlabAccounts: () => Promise.resolve({ ok: true, value: [] }) }))
vi.mock('../../bindings/list-onedrive-accounts', () => ({ listOnedriveAccounts: () => Promise.resolve({ ok: true, value: [] }) }))
vi.mock('../../bindings/get-workspace-link', () => ({ getWorkspaceLink: (...a: unknown[]) => getWorkspaceLink(...a) }))
vi.mock('../../bindings/get-version-status', () => ({ getVersionStatus: (...a: unknown[]) => getVersionStatus(...a) }))
vi.mock('../../bindings/get-local-version-status', () => ({ getLocalVersionStatus: (...a: unknown[]) => getLocalVersionStatus(...a) }))
vi.mock('../../bindings/link-workspace', () => ({ linkWorkspace: (...a: unknown[]) => linkWorkspace(...a) }))
vi.mock('../../bindings/commit-and-push', () => ({ commitAndPush: (...a: unknown[]) => commitAndPush(...a) }))
vi.mock('../../bindings/get-structured-file-changes', () => ({ getStructuredFileChanges: (...a: unknown[]) => getStructuredFileChanges(...a) }))
vi.mock('../../bindings/cancel-gitlab-operation', () => ({ cancelGitlabOperation: (...a: unknown[]) => cancelGitlabOperation(...a) }))
vi.mock('../../bindings/pick-workspace-folder', () => ({ pickWorkspaceFolder: (...a: unknown[]) => pickWorkspaceFolder(...a) }))
vi.mock('../../bindings/local-git', () => Object.fromEntries(
  Object.keys(git).map((name) => [name, (...a: unknown[]) => git[name as keyof typeof git](...a)]),
))

const ROOT = '/work/space'
const COLLECTIONS = 'alcy-collections.json'
const link: WorkspaceLinkDto = { provider: 'git', sharedFolder: null, includeEnvironments: false }
const status = (files: FileStatusDto[], current: WorkspaceLinkDto = link) => ({ ok: true, value: { link: current, files } })
const state = (overrides: Partial<GitStateDto> = {}) => ({
  ok: true,
  value: { branch: 'main', branches: ['feature', 'main'], hasCommits: true, merge: null, sharedFolder: null, ...overrides },
})
const changed: FileStatusDto = { name: COLLECTIONS, state: 'localModified', localRevision: 'l', remoteRevision: 'r' }
const conflict: FileStatusDto = { name: COLLECTIONS, state: 'conflict', localRevision: 'l', remoteRevision: 'r' }
const onFilesChanged = vi.fn()
const onOpenSettings = vi.fn()

function Harness() {
  const vc = useVersionControl(ROOT, onFilesChanged)
  return <VersionControlPanel rootPath={ROOT} vc={vc} onOpenSettings={onOpenSettings} onPull={() => {}} onResolveConflict={() => {}} embedded />
}

const commit = (id: string, summary: string, merge = false) => ({
  id, authorName: 'Ana', authorEmail: 'ana@example.com', time: 1_700_000_000, summary, files: [COLLECTIONS], merge,
})

beforeEach(() => {
  for (const mock of [getWorkspaceLink, getVersionStatus, getLocalVersionStatus, linkWorkspace, commitAndPush, getStructuredFileChanges, cancelGitlabOperation, pickWorkspaceFolder, onFilesChanged, onOpenSettings, ...Object.values(git)]) {
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
  git.getGitPeers.mockResolvedValue({ ok: true, value: [] })
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

  it('starts a new history on main without any account', async () => {
    linkWorkspace.mockResolvedValue(status([]))
    render(<Harness />)

    expect(await screen.findByText('Git neste workspace')).toBeInTheDocument()
    expect(screen.queryByText('Nenhuma conta conectada')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText(/Incluir ambientes/))
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar git' }))

    await waitFor(() => expect(linkWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      rootPath: ROOT, provider: 'git', includeEnvironments: true,
    })))
    expect(linkWorkspace.mock.calls[0][0]).not.toHaveProperty('sharedFolder')
    expect(git.syncGitSharedFolder).not.toHaveBeenCalled()
  })

  it('joins a shared workspace and brings in what was published', async () => {
    const shared = { ...link, sharedFolder: '/OneDrive/Equipe/api' }
    pickWorkspaceFolder.mockResolvedValue('/OneDrive/Equipe/api')
    linkWorkspace.mockResolvedValue(status([], shared))
    git.getGitState.mockResolvedValue(state({ sharedFolder: shared.sharedFolder, hasCommits: false, branches: [] }))
    git.syncGitSharedFolder.mockResolvedValue({
      ok: true,
      value: { published: false, integrated: ['Ana'], syncing: [], merge: null, files: [COLLECTIONS, 'alcy-workspace.json'] },
    })
    render(<Harness />)

    fireEvent.click(await screen.findByRole('button', { name: 'Escolher pasta compartilhada…' }))
    await waitFor(() => expect(linkWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      rootPath: ROOT, provider: 'git', sharedFolder: '/OneDrive/Equipe/api',
    })))
    await waitFor(() => expect(git.syncGitSharedFolder).toHaveBeenCalledWith(ROOT, expect.any(String)))
    await waitFor(() => expect(onFilesChanged).toHaveBeenCalledWith([COLLECTIONS, 'alcy-workspace.json']))
    expect(await screen.findByText('Alterações de Ana incorporadas.')).toBeInTheDocument()
  })
})

describe('git in the workspace — branches', () => {
  it('commits with a message and switches branches, reloading the rewritten files', async () => {
    git.switchGitBranch.mockResolvedValue({ ok: true, value: { files: [COLLECTIONS] } })
    render(<Harness />)

    const branch = await screen.findByRole('combobox', { name: 'Branch' })
    expect(branch).toHaveValue('main')
    expect(screen.getByRole('button', { name: 'Commit' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Mensagem do commit' })).toBeInTheDocument()

    fireEvent.change(branch, { target: { value: 'feature' } })
    await waitFor(() => expect(git.switchGitBranch).toHaveBeenCalledWith(ROOT, 'feature'))
    await waitFor(() => expect(onFilesChanged).toHaveBeenCalledWith([COLLECTIONS]))
    expect(await screen.findByText('Agora em feature.')).toBeInTheDocument()
  })

  it('creates, merges and deletes branches', async () => {
    git.createGitBranch.mockResolvedValue({ ok: true, value: { files: [] } })
    git.mergeGitBranch.mockResolvedValue({ ok: true, value: { outcome: 'merged', conflicts: [], files: [COLLECTIONS] } })
    git.deleteGitBranch.mockResolvedValue({ ok: true, value: null })
    render(<Harness />)

    fireEvent.click(await screen.findByRole('button', { name: 'Nova branch' }))
    const nameInput = screen.getByRole('textbox', { name: 'Nome da branch' })
    // Suggested from the git user and today's date.
    await waitFor(() => expect((nameInput as HTMLInputElement).value).toMatch(/^ana-lima-\d{4}-\d{2}-\d{2}$/))
    fireEvent.change(nameInput, { target: { value: 'Teste Login' } })
    expect(screen.getByText('Será criada como teste-login.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }))
    await waitFor(() => expect(git.createGitBranch).toHaveBeenCalledWith(ROOT, 'teste-login', true))

    fireEvent.click(await screen.findByRole('button', { name: 'Mesclar uma branch' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mesclar em main' }))
    await waitFor(() => expect(git.mergeGitBranch).toHaveBeenCalledWith(ROOT, 'feature'))
    expect(await screen.findByText('feature mesclada.')).toBeInTheDocument()
    expect(onFilesChanged).toHaveBeenCalledWith([COLLECTIONS])

    fireEvent.click(screen.getByRole('button', { name: 'Excluir uma branch' }))
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/Excluir a branch feature\?/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }))
    await waitFor(() => expect(git.deleteGitBranch).toHaveBeenCalledWith(ROOT, 'feature'))
  })

  it('asks for the first commit before creating branches', async () => {
    git.getGitState.mockResolvedValue(state({ hasCommits: false, branches: [] }))
    render(<Harness />)

    expect(await screen.findByText('Faça o primeiro commit para criar branches.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Nova branch' })).toBeDisabled()
  })
})

describe('git in the workspace — pending merge', () => {
  it('replaces the commit with finishing the merge once conflicts are resolved', async () => {
    git.getGitState.mockResolvedValue(state({ merge: { label: 'Bia', conflicts: [COLLECTIONS] } }))
    getVersionStatus.mockResolvedValue(status([conflict]))
    git.finishGitMerge.mockResolvedValue({ ok: true, value: { commitId: 'abc' } })
    render(<Harness />)

    expect(await screen.findByText('Mesclando alterações de Bia')).toBeInTheDocument()
    expect(await screen.findByText('1 arquivo(s) com conflito: resolva abaixo.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Commit' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Concluir mesclagem' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Branch' })).toBeDisabled()

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

describe('git in the workspace — shared folder', () => {
  it('chooses a shared folder', async () => {
    pickWorkspaceFolder.mockResolvedValue('/OneDrive/Equipe/api')
    git.setGitSharedFolder.mockResolvedValue({ ok: true, value: { ...link, sharedFolder: '/OneDrive/Equipe/api' } })
    render(<Harness />)

    expect(await screen.findByText(/Para trabalhar com outras pessoas/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Escolher pasta…' }))
    await waitFor(() => expect(git.setGitSharedFolder).toHaveBeenCalledWith(ROOT, '/OneDrive/Equipe/api'))
    expect(await screen.findByText('Pasta compartilhada definida. Sincronize para publicar seus commits.')).toBeInTheDocument()
  })

  it('shows everyone and syncs', async () => {
    const shared = { ...link, sharedFolder: '/OneDrive/Equipe/api' }
    getWorkspaceLink.mockResolvedValue({ ok: true, value: shared })
    getVersionStatus.mockResolvedValue(status([], shared))
    git.getGitState.mockResolvedValue(state({ sharedFolder: shared.sharedFolder }))
    git.getGitPeers.mockResolvedValue({
      ok: true,
      value: [
        { peer: 'ana-1', name: 'Ana', time: 1_700_000_000, state: 'incoming' },
        { peer: 'bia-2', name: 'bia-2', time: 0, state: 'syncing' },
      ],
    })
    git.syncGitSharedFolder.mockResolvedValue({
      ok: true,
      value: { published: true, integrated: ['Ana'], syncing: ['bia-2'], merge: null, files: [COLLECTIONS] },
    })
    render(<Harness />)

    const peers = await screen.findByRole('list', { name: 'Pessoas na pasta compartilhada' })
    expect(within(peers).getByText('Ana')).toBeInTheDocument()
    expect(within(peers).getByText(/alterações novas/)).toBeInTheDocument()
    expect(within(peers).getByText(/ainda sincronizando/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar (1 com alterações)' }))
    await waitFor(() => expect(git.syncGitSharedFolder).toHaveBeenCalledWith(ROOT, expect.any(String)))
    expect(await screen.findByText(/Alterações de Ana incorporadas\. Aguardando o app de sincronização trazer as alterações de bia-2\./)).toBeInTheDocument()
    expect(onFilesChanged).toHaveBeenCalledWith([COLLECTIONS])
  })
})

describe('git in the workspace — history', () => {
  it('pages, opens a commit per item and restores a file', async () => {
    git.getGitHistory
      .mockResolvedValueOnce({ ok: true, value: { commits: [commit('a'.repeat(40), 'Merge changes from Bia', true)], nextOffset: 1 } })
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

    fireEvent.click(await screen.findByRole('button', { name: 'Histórico' }))
    expect(await screen.findByText('Merge changes from Bia')).toBeInTheDocument()
    expect(screen.getByText('mesclagem')).toBeInTheDocument()
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

describe('git in the workspace — author', () => {
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
