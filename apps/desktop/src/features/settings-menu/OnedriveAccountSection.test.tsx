import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../test-utils'
import { SettingsMenu } from './SettingsMenu'

const listOnedriveAccounts = vi.fn()
const beginOnedriveLogin = vi.fn()
const logoutOnedrive = vi.fn()

vi.mock('../../shared/feature-flags', () => ({ FEATURE_FLAGS: { updates: false, valueMonitors: true, gitlab: false, onedrive: true, notifications: true } }))

vi.mock('../../bindings/get-proxy-settings', () => ({
  getProxySettings: () => Promise.resolve({ ok: true, value: { mode: 'disabled', pacUrl: null, error: null } }),
}))
vi.mock('../../bindings/list-gitlab-accounts', () => ({
  listGitlabAccounts: () => Promise.resolve({ ok: true, value: [] }),
}))
vi.mock('../../bindings/list-onedrive-accounts', () => ({
  listOnedriveAccounts: (...args: unknown[]) => listOnedriveAccounts(...args),
}))
vi.mock('../../bindings/begin-onedrive-login', () => ({
  beginOnedriveLogin: (...args: unknown[]) => beginOnedriveLogin(...args),
}))
vi.mock('../../bindings/logout-onedrive', () => ({
  logoutOnedrive: (...args: unknown[]) => logoutOnedrive(...args),
}))

const account = { id: 'ana@contoso.com', tenant: 'organizations', clientId: 'cid', username: 'ana@contoso.com', name: 'Ana' }

beforeEach(() => {
  vi.unstubAllEnvs()
  listOnedriveAccounts.mockReset()
  beginOnedriveLogin.mockReset()
  logoutOnedrive.mockReset()
  listOnedriveAccounts.mockResolvedValue({ ok: true, value: [] })
})

const renderOpen = () => {
  const result = render(<SettingsMenu open onOpenChange={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'OneDrive' }))
  return result
}

describe('SettingsMenu — conta OneDrive', () => {
  it('sem aplicativo no build, pede o client_id e envia o tenant informado', async () => {
    beginOnedriveLogin.mockResolvedValue({ ok: true, value: account })
    renderOpen()
    const login = await screen.findByRole('button', { name: 'Entrar com a Microsoft' })
    expect(login).toBeDisabled()

    fireEvent.change(screen.getByLabelText('ID do aplicativo (client)'), { target: { value: ' app-id ' } })
    fireEvent.change(screen.getByLabelText('Tenant (opcional)'), { target: { value: 'organizations' } })
    fireEvent.click(login)

    expect(await screen.findByText('Ana')).toBeInTheDocument()
    expect(beginOnedriveLogin).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'app-id', tenant: 'organizations' }))
  })

  it('com o aplicativo do build, entra sem pedir o client_id', async () => {
    vi.stubEnv('VITE_ONEDRIVE_CLIENT_ID', 'bundled-id')
    vi.stubEnv('VITE_ONEDRIVE_TENANT', 'contoso.com')
    beginOnedriveLogin.mockResolvedValue({ ok: true, value: account })
    renderOpen()

    const login = await screen.findByRole('button', { name: 'Entrar com a Microsoft' })
    expect(screen.queryByLabelText('ID do aplicativo (client)')).not.toBeInTheDocument()
    fireEvent.click(login)

    await waitFor(() =>
      expect(beginOnedriveLogin).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'bundled-id', tenant: 'contoso.com' })),
    )
  })

  it('desconecta a conta', async () => {
    listOnedriveAccounts.mockResolvedValue({ ok: true, value: [account] })
    logoutOnedrive.mockResolvedValue({ ok: true, value: null })
    renderOpen()

    fireEvent.click(await screen.findByRole('button', { name: 'Desconectar' }))

    await waitFor(() => expect(screen.queryByText('Ana')).not.toBeInTheDocument())
    expect(logoutOnedrive).toHaveBeenCalledWith(account.id)
  })
})
