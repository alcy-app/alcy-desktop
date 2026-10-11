import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../test-utils'
import { SettingsMenu } from './SettingsMenu'

const listGitlabAccounts = vi.fn()
const beginGitlabLogin = vi.fn()
const cancelGitlabOperation = vi.fn()
const logoutGitlab = vi.fn()

vi.mock('../../shared/feature-flags', () => ({ FEATURE_FLAGS: { updates: false, valueMonitors: true, gitlab: true, notifications: true } }))

vi.mock('../../bindings/get-proxy-settings', () => ({
  getProxySettings: () => Promise.resolve({ ok: true, value: { mode: 'disabled', pacUrl: null, error: null } }),
}))
vi.mock('../../bindings/list-gitlab-accounts', () => ({
  listGitlabAccounts: (...args: unknown[]) => listGitlabAccounts(...args),
}))
vi.mock('../../bindings/begin-gitlab-login', () => ({
  beginGitlabLogin: (...args: unknown[]) => beginGitlabLogin(...args),
}))
vi.mock('../../bindings/cancel-gitlab-operation', () => ({
  cancelGitlabOperation: (...args: unknown[]) => cancelGitlabOperation(...args),
}))
vi.mock('../../bindings/logout-gitlab', () => ({
  logoutGitlab: (...args: unknown[]) => logoutGitlab(...args),
}))

const account = { id: 'ana@gitlab.com', baseUrl: 'https://gitlab.com', clientId: 'cid', username: 'ana', name: 'Ana' }

beforeEach(() => {
  vi.unstubAllEnvs()
  listGitlabAccounts.mockReset()
  beginGitlabLogin.mockReset()
  cancelGitlabOperation.mockReset()
  logoutGitlab.mockReset()
  listGitlabAccounts.mockResolvedValue({ ok: true, value: [] })
})

const renderOpen = () => {
  const result = render(<SettingsMenu open onOpenChange={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'GitLab' }))
  return result
}

describe('SettingsMenu — conta GitLab', () => {
  it('só habilita "Conectar ao GitLab" com a URL e o client_id preenchidos', async () => {
    renderOpen()
    const login = await screen.findByRole('button', { name: 'Conectar ao GitLab' })
    expect(login).toBeDisabled()

    fireEvent.change(screen.getByLabelText('ID do aplicativo'), { target: { value: 'meu-app' } })
    expect(login).toBeEnabled()

    fireEvent.change(screen.getByLabelText('Endereço do GitLab'), { target: { value: '  ' } })
    expect(login).toBeDisabled()
  })

  it('faz o login e mostra a conta conectada', async () => {
    beginGitlabLogin.mockResolvedValue({ ok: true, value: account })
    renderOpen()

    fireEvent.change(await screen.findByLabelText('ID do aplicativo'), { target: { value: ' meu-app ' } })
    fireEvent.change(screen.getByLabelText('Endereço do GitLab'), { target: { value: 'https://gitlab.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Conectar ao GitLab' }))

    expect(await screen.findByText('Ana')).toBeInTheDocument()
    expect(beginGitlabLogin).toHaveBeenCalledWith(
      expect.objectContaining({ instanceUrl: 'https://gitlab.com', clientId: 'meu-app' }),
    )
    expect(screen.queryByLabelText('Endereço do GitLab')).not.toBeInTheDocument()
  })

  it('permite cancelar o login sem mostrar erro', async () => {
    let finishLogin: (value: unknown) => void = () => {}
    beginGitlabLogin.mockReturnValue(new Promise((resolve) => (finishLogin = resolve)))
    renderOpen()

    fireEvent.change(await screen.findByLabelText('ID do aplicativo'), { target: { value: 'meu-app' } })
    fireEvent.click(screen.getByRole('button', { name: 'Conectar ao GitLab' }))

    expect(await screen.findByText('Aguardando a autorização no navegador…')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    const operationId = (beginGitlabLogin.mock.calls[0][0] as { operationId: string }).operationId
    expect(cancelGitlabOperation).toHaveBeenCalledWith(operationId)

    finishLogin({ ok: false, error: { kind: 'cancelled' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Conectar ao GitLab' })).toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('mostra o erro quando a porta de retorno está ocupada', async () => {
    beginGitlabLogin.mockResolvedValue({ ok: false, error: { kind: 'portBusy', port: 53682 } })
    renderOpen()

    fireEvent.change(await screen.findByLabelText('ID do aplicativo'), { target: { value: 'meu-app' } })
    fireEvent.click(screen.getByRole('button', { name: 'Conectar ao GitLab' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('A porta de retorno 53682 está ocupada')
  })

  it('sai da conta', async () => {
    listGitlabAccounts.mockResolvedValue({ ok: true, value: [account] })
    logoutGitlab.mockResolvedValue({ ok: true, value: null })
    renderOpen()

    fireEvent.click(await screen.findByRole('button', { name: 'Desconectar' }))

    await waitFor(() => expect(logoutGitlab).toHaveBeenCalledWith('ana@gitlab.com'))
    expect(await screen.findByLabelText('Endereço do GitLab')).toBeInTheDocument()
  })
})

it('expande ajuda e seleciona o endereço de retorno para copiar', async () => {
  renderOpen()
  const help = await screen.findByRole('button', { name: 'Configurar OAuth' })
  expect(help).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('textbox', { name: 'Endereço de retorno' })).not.toBeInTheDocument()
  fireEvent.click(help)
  const urls = screen.getByRole('textbox', { name: 'Endereço de retorno' }) as HTMLInputElement
  expect(urls.value).toBe('http://127.0.0.1:53682/callback')
  fireEvent.focus(urls)
  expect(urls.selectionStart).toBe(0)
  expect(urls.selectionEnd).toBe(urls.value.length)
})

it('conecta ao GitLab.com sem pedir configuração técnica quando o build tem um Application ID', async () => {
  vi.stubEnv('VITE_GITLAB_COM_CLIENT_ID', 'alcy-public-client')
  beginGitlabLogin.mockResolvedValue({ ok: true, value: account })
  renderOpen()

  expect(await screen.findByText('Permissão: acesso completo à API para ler e gravar arquivos.')).toBeVisible()
  expect(screen.queryByLabelText('Endereço do GitLab')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Conectar ao GitLab' }))

  await waitFor(() => expect(beginGitlabLogin).toHaveBeenCalledWith(
    expect.objectContaining({ instanceUrl: 'https://gitlab.com', clientId: 'alcy-public-client' }),
  ))
})

it('preserva os dados e a autorização em andamento ao trocar de categoria', async () => {
  let finishLogin: (value: unknown) => void = () => {}
  beginGitlabLogin.mockReturnValue(new Promise((resolve) => (finishLogin = resolve)))
  renderOpen()
  fireEvent.change(await screen.findByLabelText('ID do aplicativo'), { target: { value: 'meu-app' } })
  fireEvent.click(screen.getByRole('button', { name: 'Conectar ao GitLab' }))
  expect(await screen.findByLabelText('ID do aplicativo')).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Aparência' }))
  expect(screen.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'GitLab' }))
  expect(screen.getByLabelText('ID do aplicativo')).toHaveValue('meu-app')
  expect(screen.getByRole('button', { name: 'Cancelar' })).toBeVisible()
  finishLogin({ ok: true, value: account })
  expect(await screen.findByText('Ana')).toBeVisible()
})

it('mostra carregamento enquanto busca as contas', async () => {
  let finishLoading: (value: unknown) => void = () => {}
  listGitlabAccounts.mockReturnValue(new Promise((resolve) => (finishLoading = resolve)))
  renderOpen()
  expect(screen.getByRole('status')).toHaveTextContent('Buscando contas conectadas')
  expect(screen.queryByRole('button', { name: 'Conectar ao GitLab' })).not.toBeInTheDocument()
  finishLoading({ ok: true, value: [] })
  expect(await screen.findByRole('button', { name: 'Conectar ao GitLab' })).toBeVisible()
})

it('mantém a conta e exibe o erro se a desconexão falhar', async () => {
  listGitlabAccounts.mockResolvedValue({ ok: true, value: [account] })
  logoutGitlab.mockResolvedValue({ ok: false, error: { kind: 'credentials', message: 'indisponível' } })
  renderOpen()
  fireEvent.click(await screen.findByRole('button', { name: 'Desconectar' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('indisponível')
  expect(screen.getByText('Ana')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Desconectar' })).toBeEnabled()
})
