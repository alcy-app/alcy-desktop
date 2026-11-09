import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../test-utils'
import type { FileStatusDto, WorkspaceLinkDto } from '../../bindings/version-control-types'
import { useVersionControl } from './use-version-control'
import { VersionControlPanel } from './VersionControlPanel'

const getWorkspaceLink = vi.fn()
const getVersionStatus = vi.fn()
const getLocalVersionStatus = vi.fn()
const linkWorkspace = vi.fn()
const unlinkWorkspace = vi.fn()
const getFileDiff = vi.fn()
const getStructuredFileChanges = vi.fn()
const commitAndPush = vi.fn()
const pullChanges = vi.fn()
const resolveConflict = vi.fn()
const cancelVersionControlOperation = vi.fn()

vi.mock('../../bindings/get-workspace-link', () => ({ getWorkspaceLink: (...a: unknown[]) => getWorkspaceLink(...a) }))
vi.mock('../../bindings/get-version-status', () => ({ getVersionStatus: (...a: unknown[]) => getVersionStatus(...a) }))
vi.mock('../../bindings/get-local-version-status', () => ({ getLocalVersionStatus: (...a: unknown[]) => getLocalVersionStatus(...a) }))
vi.mock('../../bindings/link-workspace', () => ({ linkWorkspace: (...a: unknown[]) => linkWorkspace(...a) }))
vi.mock('../../bindings/unlink-workspace', () => ({ unlinkWorkspace: (...a: unknown[]) => unlinkWorkspace(...a) }))
vi.mock('../../bindings/get-file-diff', () => ({ getFileDiff: (...a: unknown[]) => getFileDiff(...a) }))
vi.mock('../../bindings/get-structured-file-changes', () => ({ getStructuredFileChanges: (...a: unknown[]) => getStructuredFileChanges(...a) }))
vi.mock('../../bindings/commit-and-push', () => ({ commitAndPush: (...a: unknown[]) => commitAndPush(...a) }))
vi.mock('../../bindings/pull-changes', () => ({ pullChanges: (...a: unknown[]) => pullChanges(...a) }))
vi.mock('../../bindings/resolve-conflict', () => ({ resolveConflict: (...a: unknown[]) => resolveConflict(...a) }))
vi.mock('../../bindings/cancel-version-control-operation', () => ({
  cancelVersionControlOperation: (...a: unknown[]) => cancelVersionControlOperation(...a),
}))
vi.mock('../../shared/feature-flags', () => ({ FEATURE_FLAGS: { localGit: true } }))
vi.mock('../../bindings/local-git', () => ({
  getGitState: () => Promise.resolve({ ok: true, value: gitState }),
  getGitHistory: () => Promise.resolve({ ok: true, value: { commits: [], nextOffset: null } }),
}))
vi.mock('../../bindings/get-proxy-settings', () => ({
  getProxySettings: () => Promise.resolve({ ok: true, value: { mode: 'disabled', pacUrl: null, error: null } }),
}))

const link: WorkspaceLinkDto = { includeEnvironments: false }
const gitState = { branch: 'main', branches: ['main'], hasCommits: true, merge: null, remote: 'git@example.com:team/api.git', tracking: null }
const status = (files: FileStatusDto[]) => ({ ok: true, value: { link, files } })
const ROOT = '/work/space'

const onFilesChanged = vi.fn()
const onOpenSettings = vi.fn()
const onPull = vi.fn()
const onResolveConflict = vi.fn()

function Harness({ embedded = false }: { embedded?: boolean }) {
  const vc = useVersionControl(ROOT, onFilesChanged)
  return <VersionControlPanel rootPath={ROOT} vc={vc} onClose={() => {}} onOpenSettings={onOpenSettings} onPull={onPull} onResolveConflict={onResolveConflict} embedded={embedded} />
}

beforeEach(() => {
  for (const mock of [
    getWorkspaceLink, getVersionStatus, getLocalVersionStatus, linkWorkspace, unlinkWorkspace, getFileDiff, getStructuredFileChanges, commitAndPush, pullChanges, resolveConflict, cancelVersionControlOperation,
    onFilesChanged, onOpenSettings, onPull, onResolveConflict, ]) {
    mock.mockReset()
  }
  getWorkspaceLink.mockResolvedValue({ ok: true, value: null })
  getLocalVersionStatus.mockResolvedValue({ ok: true, value: [] })
  getStructuredFileChanges.mockImplementation((_root: string, _operation: string, name: string) => Promise.resolve({
    ok: true,
    value: { name, localRevision: 'local', remoteRevision: 'remote', supportsPartial: false, items: [] },
  }))
})

describe('VersionControlPanel — vinculado', () => {
  beforeEach(() => {
    getWorkspaceLink.mockResolvedValue({ ok: true, value: link })
  })

  it('mostra que está sincronizado quando não há alterações', async () => {
    getVersionStatus.mockResolvedValue(status([{ name: 'alcy-flows.json', state: 'clean' }]))
    render(<Harness />)

    expect(await screen.findByText('Tudo sincronizado.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled()
  })

  it('in the sidebar, pins the repository header outside the scrolling body', async () => {
    getVersionStatus.mockResolvedValue(status([{ name: 'alcy-flows.json', state: 'clean' }]))
    render(<Harness embedded />)

    expect(await screen.findByText('Tudo sincronizado.')).toBeInTheDocument()
    const header = document.querySelector('.vc-repository') as HTMLElement
    const body = document.querySelector('.vc-linked-body') as HTMLElement
    expect(header).toContainElement(screen.getByRole('button', { name: 'Verificar' }))
    expect(header).not.toContainElement(body)
    expect(body).toContainElement(screen.getByText('Tudo sincronizado.'))
  })

  it('não declara sincronização antes da primeira consulta válida', async () => {
    getVersionStatus.mockImplementation(() => new Promise(() => {}))
    render(<Harness />)

    expect(await screen.findByRole('button', { name: 'Verificar' })).toBeInTheDocument()
    expect(screen.queryByText('Tudo sincronizado.')).not.toBeInTheDocument()
  })

  it('compartilha consultas sobrepostas, limita foco e preserva atualização manual', async () => {
    let resolveStatus!: (value: ReturnType<typeof status>) => void
    getVersionStatus.mockImplementation(() => new Promise<ReturnType<typeof status>>((resolve) => {
      resolveStatus = resolve
    }))
    render(<Harness />)

    expect(await screen.findByRole('button', { name: 'Verificar' })).toBeInTheDocument()
    await waitFor(() => expect(getVersionStatus).toHaveBeenCalledTimes(1))

    fireEvent.focus(window)
    fireEvent.focus(window)
    expect(getVersionStatus).toHaveBeenCalledTimes(1)

    resolveStatus(status([{ name: 'alcy-flows.json', state: 'clean' }]))
    expect(await screen.findByText('Tudo sincronizado.')).toBeInTheDocument()

    getVersionStatus.mockResolvedValue(status([{ name: 'alcy-flows.json', state: 'clean' }]))
    fireEvent.focus(window)
    expect(getVersionStatus).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Verificar' }))
    await waitFor(() => expect(getVersionStatus).toHaveBeenCalledTimes(2))
  })

  it('carrega detalhes estruturados somente quando uma ação precisa deles', async () => {
    getVersionStatus.mockResolvedValue(status([{ name: 'alcy-collections.json', state: 'localModified' }]))
    render(<Harness />)

    const expand = await screen.findByRole('button', { name: 'Expandir alterações de alcy-collections.json' })
    expect(getStructuredFileChanges).not.toHaveBeenCalled()
    fireEvent.click(expand)

    await waitFor(() => expect(getStructuredFileChanges).toHaveBeenCalledWith(ROOT, expect.any(String), 'alcy-collections.json', undefined, undefined))
  })

  it('lista só os arquivos alterados e envia com a mensagem informada', async () => {
    getVersionStatus.mockResolvedValue(
      status([
        { name: 'alcy-collections.json', state: 'localModified' },
        { name: 'alcy-flows.json', state: 'clean' },
      ]),
    )
    commitAndPush.mockResolvedValue({ ok: true, value: { commitId: 'abc', pushed: ['alcy-collections.json'] } })
    render(<Harness />)

    expect(await screen.findByText('alcy-collections.json', { selector: '.vc-file-name' })).toBeInTheDocument()
    expect(screen.queryByText('alcy-flows.json', { selector: '.vc-file-name' })).not.toBeInTheDocument()

    const push = screen.getByRole('button', { name: 'Commit' })
    expect(push).toBeDisabled() // sem mensagem
    fireEvent.click(await screen.findByRole('button', { name: 'Preparar todo o arquivo alcy-collections.json' }))
    fireEvent.change(screen.getByLabelText('Mensagem do commit'), { target: { value: 'Ajusta coleção' } })
    await waitFor(() => expect(push).toBeEnabled())

    getVersionStatus.mockResolvedValue(status([{ name: 'alcy-collections.json', state: 'clean' }]))
    fireEvent.click(push)

    await waitFor(() => expect(commitAndPush).toHaveBeenCalledWith(ROOT, expect.any(String), 'Ajusta coleção', [expect.objectContaining({ name: 'alcy-collections.json', wholeFile: true })]))
    await waitFor(() => expect(screen.getByLabelText('Mensagem do commit')).toHaveValue(''))
  })

  it('preserva mensagem e preparação quando o envio falha', async () => {
    getVersionStatus.mockResolvedValue(status([{ name: 'alcy-collections.json', state: 'localModified' }]))
    commitAndPush.mockResolvedValue({ ok: false, error: { kind: 'network', message: 'offline' } })
    render(<Harness />)

    const stageFile = await screen.findByRole('button', { name: 'Preparar todo o arquivo alcy-collections.json' })
    await waitFor(() => expect(stageFile).toBeEnabled())
    fireEvent.click(stageFile)
    fireEvent.change(screen.getByLabelText('Mensagem do commit'), { target: { value: 'Tenta enviar' } })
    const push = screen.getByRole('button', { name: 'Commit' })
    await waitFor(() => expect(push).toBeEnabled())
    fireEvent.click(push)

    expect(await screen.findByText('Falha de rede: offline')).toBeInTheDocument()
    expect(screen.getByLabelText('Mensagem do commit')).toHaveValue('Tenta enviar')
    expect(screen.getByRole('button', { name: 'Retirar o arquivo alcy-collections.json da preparação' })).toBeInTheDocument()
  })

  it('permite selecionar e enviar apenas uma requisição do arquivo', async () => {
    getVersionStatus.mockResolvedValue(status([{ name: 'alcy-collections.json', state: 'localModified' }]))
    getStructuredFileChanges.mockResolvedValue({
      ok: true,
      value: {
        name: 'alcy-collections.json', localRevision: 'local', remoteRevision: 'remote', supportsPartial: true,
        items: [
          { id: 'request:r1', parentId: 'collection:c1', label: 'List users', itemKind: 'request', changeKind: 'modified', fields: [{ name: 'endpoint', remote: '/users', local: '/v2/users' }], dependencies: [] },
          { id: 'request:r2', parentId: 'collection:c1', label: 'Create user', itemKind: 'request', changeKind: 'modified', fields: [], dependencies: [] },
        ],
      },
    })
    commitAndPush.mockResolvedValue({ ok: true, value: { commitId: 'abc', pushed: ['alcy-collections.json'] } })
    render(<Harness />)

    const expand = await screen.findByRole('button', { name: 'Expandir alterações de alcy-collections.json' })
    await waitFor(() => expect(expand).toBeEnabled())
    fireEvent.click(expand)
    fireEvent.click(await screen.findByRole('button', { name: 'Preparar List users' }))
    fireEvent.change(screen.getByLabelText('Mensagem do commit'), { target: { value: 'Atualiza listagem' } })
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))

    await waitFor(() => expect(commitAndPush).toHaveBeenCalledWith(ROOT, expect.any(String), 'Atualiza listagem', [expect.objectContaining({
      name: 'alcy-collections.json', wholeFile: false, itemIds: ['request:r1'],
    })]))
  })

  it('prepara dependências de flows e retira os flows quando uma dependência é retirada', async () => {
    getVersionStatus.mockResolvedValue(status([
      { name: 'alcy-collections.json', state: 'localModified' },
      { name: 'alcy-flows.json', state: 'localModified' },
    ]))
    getStructuredFileChanges.mockImplementation((_root: string, _operation: string, name: string) => Promise.resolve({
      ok: true,
      value: name === 'alcy-flows.json' ? {
        name,
        localRevision: 'flows-local',
        remoteRevision: 'flows-remote',
        supportsPartial: true,
        items: [{ id: 'flow:f1', parentId: null, label: 'Daily sync', itemKind: 'flow', changeKind: 'modified', fields: [], dependencies: ['request:r1'] }],
      } : {
        name,
        localRevision: 'collections-local',
        remoteRevision: 'collections-remote',
        supportsPartial: true,
        items: [{ id: 'request:r1', parentId: 'collection:c1', label: 'Get user', itemKind: 'request', changeKind: 'modified', fields: [], dependencies: [] }],
      },
    }))
    render(<Harness />)

    fireEvent.click(await screen.findByRole('button', { name: 'Expandir alterações de alcy-flows.json' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Preparar Daily sync' }))

    expect(await screen.findByRole('button', { name: 'Retirar Daily sync da preparação' })).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Expandir alterações de alcy-collections.json' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Retirar Get user da preparação' }))

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retirar Daily sync da preparação' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Preparar Daily sync' })).toBeInTheDocument()
  })

  it('retira a preparação quando a revisão observada muda', async () => {
    getVersionStatus.mockResolvedValue(status([{ name: 'alcy-collections.json', state: 'localModified' }]))
    getStructuredFileChanges.mockResolvedValue({
      ok: true,
      value: { name: 'alcy-collections.json', localRevision: 'local-1', remoteRevision: 'remote', supportsPartial: false, items: [] },
    })
    render(<Harness />)

    const stageFile = await screen.findByRole('button', { name: 'Preparar todo o arquivo alcy-collections.json' })
    await waitFor(() => expect(stageFile).toBeEnabled())
    fireEvent.click(stageFile)
    fireEvent.change(screen.getByLabelText('Mensagem do commit'), { target: { value: 'Mensagem preservada' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit' })).toBeEnabled())

    getStructuredFileChanges.mockResolvedValue({
      ok: true,
      value: { name: 'alcy-collections.json', localRevision: 'local-2', remoteRevision: 'remote', supportsPartial: false, items: [] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Verificar' }))

    expect(await screen.findByText('A preparação de alcy-collections.json foi retirada porque o conteúdo mudou.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled()
    expect(screen.getByLabelText('Mensagem do commit')).toHaveValue('Mensagem preservada')
  })

  it('bloqueia o envio quando há conflito e abre o resolvedor dedicado', async () => {
    getVersionStatus.mockResolvedValue(
      status([
        { name: 'alcy-collections.json', state: 'localModified' },
        { name: 'alcy-flows.json', state: 'conflict' },
      ]),
    )
    resolveConflict.mockResolvedValue({ ok: true, value: { localFileChanged: true } })
    render(<Harness />)

    expect(screen.queryByText('Tudo sincronizado.')).not.toBeInTheDocument()
    const resolve = await screen.findByRole('button', { name: 'Resolver' })
    await waitFor(() => expect(resolve).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Mensagem do commit'), { target: { value: 'msg' } })
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled()

    fireEvent.click(resolve)
    await waitFor(() => expect(onResolveConflict).toHaveBeenCalledWith('alcy-flows.json', expect.any(Object)))
  })

  it('mostra "Resolver" para conflito com estrutura reconhecida e delega a resolução por item', async () => {
    getVersionStatus.mockResolvedValue(status([{ name: 'alcy-collections.json', state: 'conflict' }]))
    getStructuredFileChanges.mockResolvedValue({
      ok: true,
      value: { name: 'alcy-collections.json', localRevision: 'l', remoteRevision: 'r', supportsPartial: true, items: [] },
    })
    render(<Harness />)

    const openResolver = await screen.findByRole('button', { name: 'Resolver' })
    await waitFor(() => expect(openResolver).toBeEnabled())
    fireEvent.click(openResolver)

    await waitFor(() => expect(onResolveConflict).toHaveBeenCalledWith('alcy-collections.json', expect.objectContaining({ supportsPartial: true })))
    expect(resolveConflict).not.toHaveBeenCalled()
  })

  it('revisar o que chegou delega a revisão em vez de aplicar direto', async () => {
    getVersionStatus.mockResolvedValue(status([{ name: 'alcy-collections.json', state: 'remoteChanged' }]))
    render(<Harness />)

    fireEvent.click(await screen.findByRole('button', { name: 'Revisar e atualizar' }))

    expect(onPull).toHaveBeenCalled()
    expect(pullChanges).not.toHaveBeenCalled()
  })

  it('mostra o diff do arquivo com linhas removidas e adicionadas', async () => {
    getVersionStatus.mockResolvedValue(status([{ name: 'alcy-flows.json', state: 'localModified' }]))
    getFileDiff.mockResolvedValue({
      ok: true,
      value: {
        name: 'alcy-flows.json',
        remoteExists: true,
        localExists: true,
        hunks: [
          {
            remoteStart: 1,
            localStart: 1,
            lines: [
              { kind: 'context', text: 'a' },
              { kind: 'removed', text: 'antigo' },
              { kind: 'added', text: 'novo' },
            ],
          },
        ],
        tooLarge: false,
        binary: false,
        truncated: false,
      },
    })
    render(<Harness />)

    fireEvent.click((await screen.findByText('alcy-flows.json', { selector: '.vc-file-name' })).closest('button')!)

    expect(await screen.findByText('antigo')).toBeInTheDocument()
    expect(screen.getByText('novo')).toBeInTheDocument()
    expect(getFileDiff).toHaveBeenCalledWith(ROOT, expect.any(String), 'alcy-flows.json', undefined)

    fireEvent.click(screen.getByRole('button', { name: 'Fechar diferenças' }))
    await waitFor(() => expect(screen.queryByText('antigo')).not.toBeInTheDocument())
  })

  it.each([
    ['tooLarge', 'Arquivo grande demais para comparar.'],
    ['binary', 'O arquivo não é texto.'],
  ] as const)('explica quando o diff não pode ser exibido (%s)', async (flag, message) => {
    getVersionStatus.mockResolvedValue(status([{ name: 'alcy-flows.json', state: 'localModified' }]))
    getFileDiff.mockResolvedValue({
      ok: true,
      value: {
        name: 'alcy-flows.json', remoteExists: true, localExists: true, hunks: [],
        tooLarge: flag === 'tooLarge', binary: flag === 'binary', truncated: false,
      },
    })
    render(<Harness />)

    fireEvent.click((await screen.findByText('alcy-flows.json', { selector: '.vc-file-name' })).closest('button')!)

    expect(await screen.findByText(message)).toBeInTheDocument()
  })

  it('mostra o erro estruturado quando a verificação falha', async () => {
    getVersionStatus.mockResolvedValue({ ok: false, error: { kind: 'network', message: 'offline' } })
    render(<Harness />)

    expect(await screen.findByText('Falha de rede: offline')).toBeInTheDocument()
  })

  it('desvincula e volta ao assistente de vínculo', async () => {
    getVersionStatus.mockResolvedValue(status([]))
    unlinkWorkspace.mockResolvedValue({ ok: true, value: null })
    render(<Harness />)

    fireEvent.click(await screen.findByRole('button', { name: 'Mais ações do repositório' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Desvincular' }))

    expect(await screen.findByText(/Este workspace ainda não usa Git/)).toBeInTheDocument()
    expect(unlinkWorkspace).toHaveBeenCalledWith(ROOT)
  })
})
