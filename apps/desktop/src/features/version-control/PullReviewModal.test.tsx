import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../test-utils'
import { fakeVersionControl } from './test-fixtures'
import { PullReviewModal } from './PullReviewModal'

const previewPullChanges = vi.fn()
const getStructuredFileChanges = vi.fn()
const cancelGitlabOperation = vi.fn()

vi.mock('../../bindings/preview-pull-changes', () => ({ previewPullChanges: (...a: unknown[]) => previewPullChanges(...a) }))
vi.mock('../../bindings/get-structured-file-changes', () => ({ getStructuredFileChanges: (...a: unknown[]) => getStructuredFileChanges(...a) }))
vi.mock('../../bindings/cancel-gitlab-operation', () => ({ cancelGitlabOperation: (...a: unknown[]) => cancelGitlabOperation(...a) }))

const ROOT = '/work/space'

beforeEach(() => {
  for (const mock of [previewPullChanges, getStructuredFileChanges, cancelGitlabOperation]) mock.mockReset()
  getStructuredFileChanges.mockResolvedValue({
    ok: true,
    value: { name: 'alcy-collections.json', localRevision: 'l', remoteRevision: 'r', supportsPartial: true, items: [] },
  })
})

describe('PullReviewModal', () => {
  it('mostra os arquivos que viriam do remoto antes de aplicar', async () => {
    previewPullChanges.mockResolvedValue({ ok: true, value: { incoming: ['alcy-collections.json'], conflicts: [] } })
    const vc = fakeVersionControl()
    render(<PullReviewModal rootPath={ROOT} vc={vc} onClose={() => {}} />)

    expect(await screen.findByText('Coleções')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Aplicar' })).toBeEnabled()
  })

  it('nada é aplicado até confirmar: Aplicar chama vc.pull e fecha o modal em sucesso', async () => {
    previewPullChanges.mockResolvedValue({ ok: true, value: { incoming: ['alcy-collections.json'], conflicts: [] } })
    const pull = vi.fn().mockResolvedValue({ ok: true })
    const vc = fakeVersionControl({ pull })
    const onClose = vi.fn()
    render(<PullReviewModal rootPath={ROOT} vc={vc} onClose={onClose} />)

    await screen.findByText('Coleções')
    expect(pull).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    await waitFor(() => expect(pull).toHaveBeenCalledTimes(1))
  })

  it('mostra estado vazio quando não há nada a atualizar', async () => {
    previewPullChanges.mockResolvedValue({ ok: true, value: { incoming: [], conflicts: [] } })
    const vc = fakeVersionControl()
    render(<PullReviewModal rootPath={ROOT} vc={vc} onClose={() => {}} />)

    expect(await screen.findByText('Nada para atualizar.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Aplicar' })).not.toBeInTheDocument()
  })

  it('avisa sobre arquivos em conflito sem oferecer resolvê-los aqui', async () => {
    previewPullChanges.mockResolvedValue({ ok: true, value: { incoming: [], conflicts: ['alcy-flows.json'] } })
    const vc = fakeVersionControl()
    render(<PullReviewModal rootPath={ROOT} vc={vc} onClose={() => {}} />)

    expect(await screen.findByText(/1 arquivo\(s\) em conflito/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Aplicar' })).not.toBeInTheDocument()
  })

  it('mostra o erro estruturado quando a revisão falha', async () => {
    previewPullChanges.mockResolvedValue({ ok: false, error: { kind: 'unauthorized' } })
    const vc = fakeVersionControl()
    render(<PullReviewModal rootPath={ROOT} vc={vc} onClose={() => {}} />)

    expect(await screen.findByText('Sessão expirada. Entre novamente no GitLab.')).toBeInTheDocument()
  })
})
