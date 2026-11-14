import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '../../test-utils'
import { TOOLTIP_DELAY_MS } from '../../shared/ui/use-tooltip'
import { SettingsMenu } from './SettingsMenu'

const getProxySettings = vi.fn()
const saveProxySettings = vi.fn()
const testProxySettings = vi.fn()
const listCustomCaCertificates = vi.fn()
const addCustomCaCertificate = vi.fn()
const removeCustomCaCertificate = vi.fn()
const flags = vi.hoisted(() => ({ updates: true, localGit: false }))

vi.mock('../../shared/feature-flags', () => ({ FEATURE_FLAGS: flags }))
const getGitIdentity = vi.fn()
vi.mock('../../bindings/local-git', () => ({
  getGitIdentity: (...args: unknown[]) => getGitIdentity(...args),
  saveGitIdentity: vi.fn(),
}))

vi.mock('../../bindings/get-proxy-settings', () => ({
  getProxySettings: (...args: unknown[]) => getProxySettings(...args),
}))
vi.mock('../../bindings/save-proxy-settings', () => ({
  saveProxySettings: (...args: unknown[]) => saveProxySettings(...args),
}))
vi.mock('../../bindings/test-proxy-settings', () => ({
  testProxySettings: (...args: unknown[]) => testProxySettings(...args),
}))
vi.mock('../../bindings/custom-ca-certificates', () => ({
  listCustomCaCertificates: (...args: unknown[]) => listCustomCaCertificates(...args),
  addCustomCaCertificate: (...args: unknown[]) => addCustomCaCertificate(...args),
  removeCustomCaCertificate: (...args: unknown[]) => removeCustomCaCertificate(...args),
}))
const getTlsSettings = vi.fn()
const saveTlsSettings = vi.fn()
vi.mock('../../bindings/tls-settings', () => ({
  getTlsSettings: (...args: unknown[]) => getTlsSettings(...args),
  saveTlsSettings: (...args: unknown[]) => saveTlsSettings(...args),
}))
vi.mock('../../bindings/pick-custom-ca-certificate', () => ({
  pickCustomCaCertificate: () => Promise.resolve(null),
}))

const getGeneralSettings = vi.fn()
const saveGeneralSettings = vi.fn()
const getSecuritySettings = vi.fn()
const saveSecuritySettings = vi.fn()

vi.mock('../../bindings/get-security-settings', () => ({
  getSecuritySettings: (...args: unknown[]) => getSecuritySettings(...args),
}))
vi.mock('../../bindings/save-security-settings', () => ({
  saveSecuritySettings: (...args: unknown[]) => saveSecuritySettings(...args),
}))

vi.mock('../../bindings/get-general-settings', () => ({
  getGeneralSettings: (...args: unknown[]) => getGeneralSettings(...args),
}))
vi.mock('../../bindings/save-general-settings', () => ({
  saveGeneralSettings: (...args: unknown[]) => saveGeneralSettings(...args),
}))

beforeEach(() => {
  flags.updates = true
  flags.localGit = true
  getGitIdentity.mockReset()
  getGitIdentity.mockResolvedValue({
    ok: true,
    value: { system: { name: 'Ana', email: 'ana@example.com' }, overrides: { name: null, email: null }, effective: { name: 'Ana', email: 'ana@example.com' } },
  })
  getProxySettings.mockReset()
  saveProxySettings.mockReset()
  testProxySettings.mockReset()
  getProxySettings.mockResolvedValue({ ok: true, value: { mode: 'disabled', pacUrl: null, error: null } })
  listCustomCaCertificates.mockReset()
  addCustomCaCertificate.mockReset()
  removeCustomCaCertificate.mockReset()
  listCustomCaCertificates.mockResolvedValue({ ok: true, value: [] })
  getTlsSettings.mockReset()
  saveTlsSettings.mockReset()
  getTlsSettings.mockResolvedValue({ ok: true, value: { verifyCertificates: true } })
  getGeneralSettings.mockReset()
  saveGeneralSettings.mockReset()
  getGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: 60, responseSizeLimitMb: 50, historyRetentionDays: 7, saveHistoryResponses: false, k6ImportLimitKb: 512 } })
  getSecuritySettings.mockReset()
  saveSecuritySettings.mockReset()
  getSecuritySettings.mockResolvedValue({ ok: true, value: { syncSensitiveValues: false, allowBodyFilesOutsideWorkspace: false } })
})

const renderOpen = () => {
  const result = render(<SettingsMenu open onOpenChange={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Rede e certificados' }))
  return result
}

describe('SettingsMenu — search and shared preferences', () => {
  it('finds accented labels, navigates with the keyboard and focuses the setting', async () => {
    render(<SettingsMenu open onOpenChange={() => {}} />)
    const search = screen.getByRole('searchbox', { name: 'Buscar opções…' })
    fireEvent.change(search, { target: { value: 'RETENCAO' } })
    const results = screen.getByRole('list', { name: 'Resultados da busca' })
    expect(within(results).getByRole('button', { name: 'Retenção do histórico Dados e privacidade' })).toBeVisible()
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(within(results).getAllByRole('button')[0]).toHaveFocus()
    fireEvent.click(document.activeElement!)
    expect(screen.getByRole('button', { name: 'Dados e privacidade' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('history-retention-settings')).toHaveFocus()
    expect(search).toHaveValue('')
    expect(await screen.findByRole('spinbutton', { name: 'Retenção do histórico em dias' })).toBeVisible()
  })

  it('clears an empty search with Escape without closing the modal and excludes disabled tools', () => {
    flags.localGit = false
    const onOpenChange = vi.fn()
    render(<SettingsMenu open onOpenChange={onOpenChange} />)
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'git' } })
    expect(screen.getByText('Nenhuma opção encontrada. Tente outro termo.')).toBeVisible()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(search).toHaveValue('')
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole('navigation')).toBeVisible()
  })

  it('preserves a proxy draft while using search and supports clearing results', async () => {
    renderOpen()
    await waitFor(() => expect(getProxySettings).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('radio', { name: 'Script PAC' }))
    fireEvent.change(screen.getByLabelText('URL do script'), { target: { value: 'https://example.com/draft.pac' } })
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'timeout' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(screen.getByTestId('general-settings')).toHaveFocus()
    fireEvent.change(search, { target: { value: 'proxy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Limpar busca' }))
    expect(search).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Rede e certificados' }))
    expect(screen.getByLabelText('URL do script')).toHaveValue('https://example.com/draft.pac')
    expect(saveProxySettings).not.toHaveBeenCalled()
  })

  it('serializes saves across pages using the latest successful snapshot', async () => {
    const updated = { requestTimeoutSeconds: 30, responseSizeLimitMb: 50, historyRetentionDays: 7, saveHistoryResponses: false, k6ImportLimitKb: 512 }
    let finishFirst!: (value: { ok: true; value: typeof updated }) => void
    saveGeneralSettings.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve }))
    saveGeneralSettings.mockImplementationOnce(async (input) => ({ ok: true, value: input }))
    render(<SettingsMenu open initialCategory="requests" onOpenChange={() => {}} />)
    const timeout = await screen.findByRole('spinbutton', { name: 'Timeout em segundos' })
    await waitFor(() => expect(timeout).toBeEnabled())
    fireEvent.change(timeout, { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    await waitFor(() => expect(saveGeneralSettings).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Dados e privacidade' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Retenção do histórico em dias' }), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar retenção do histórico' }))
    expect(saveGeneralSettings).toHaveBeenCalledTimes(1)
    finishFirst({ ok: true, value: updated })
    await waitFor(() => expect(saveGeneralSettings).toHaveBeenLastCalledWith({ ...updated, historyRetentionDays: 3 }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Aplicar retenção do histórico' })).toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: 'Requisições' }))
    expect(timeout).toHaveValue(30)
    expect(getGeneralSettings).toHaveBeenCalledTimes(1)
  })
})

describe('SettingsMenu — proxy', () => {
  it('shows the URL only for PAC and disables Apply without changes', async () => {
    renderOpen()
    const apply = await screen.findByRole('button', { name: 'Aplicar' })
    expect(apply).toBeDisabled()
    expect(screen.queryByLabelText('URL do script')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Script PAC' }))
    expect(screen.getByLabelText('URL do script')).toBeInTheDocument()
    expect(apply).toBeDisabled() // Empty URL

    fireEvent.change(screen.getByLabelText('URL do script'), { target: { value: 'https://corp/p.pac' } })
    expect(apply).toBeEnabled()
  })

  it('applies the system proxy', async () => {
    saveProxySettings.mockResolvedValue({ ok: true, value: { mode: 'system', pacUrl: null, error: null } })
    renderOpen()

    fireEvent.click(await screen.findByRole('radio', { name: 'Sistema' }))
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    await waitFor(() => expect(saveProxySettings).toHaveBeenCalledWith({ mode: 'system', pacUrl: null }))
    expect(await screen.findByText('Configuração de proxy aplicada.')).toBeInTheDocument()
  })

  it('tests the PAC script and displays the returned error', async () => {
    testProxySettings.mockResolvedValueOnce({ ok: true })
    testProxySettings.mockResolvedValueOnce({ ok: false, error: { kind: 'pac', message: 'resposta HTTP 404' } })
    renderOpen()

    fireEvent.click(await screen.findByRole('radio', { name: 'Script PAC' }))
    fireEvent.change(screen.getByLabelText('URL do script'), { target: { value: ' https://corp/p.pac ' } })

    fireEvent.click(screen.getByRole('button', { name: 'Testar' }))
    expect(await screen.findByText('Script baixado e validado com sucesso.')).toBeInTheDocument()
    expect(testProxySettings).toHaveBeenCalledWith({ mode: 'pac', pacUrl: 'https://corp/p.pac' })

    fireEvent.click(screen.getByRole('button', { name: 'Testar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('resposta HTTP 404')
  })

  it('reflects saved settings loaded after opening the modal', async () => {
    getProxySettings.mockResolvedValue({ ok: true, value: { mode: 'pac', pacUrl: 'https://corp/p.pac', error: null } })
    renderOpen()

    expect(await screen.findByDisplayValue('https://corp/p.pac')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Script PAC' })).toBeChecked()
  })

  it('warns when saved proxy settings could not be applied', async () => {
    getProxySettings.mockResolvedValue({
      ok: true,
      value: { mode: 'pac', pacUrl: 'https://corp/p.pac', error: 'resposta HTTP 500' },
    })
    renderOpen()

    expect(await screen.findByRole('alert')).toHaveTextContent('resposta HTTP 500')
  })
})


describe('SettingsMenu — trigger tooltip', () => {
  it('does not show the trigger tooltip when hovering the modal', async () => {
    render(<SettingsMenu open onOpenChange={() => {}} />)
    // React mouse events cross the modal portal to its ancestors.
    fireEvent.mouseEnter(screen.getByRole('dialog'))
    await new Promise((resolve) => setTimeout(resolve, TOOLTIP_DELAY_MS + 50))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('shows the tooltip when hovering the trigger', async () => {
    render(<SettingsMenu open={false} onOpenChange={() => {}} />)
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Configurações' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Configurações')
  })
})

describe('SettingsMenu — categories', () => {
  it('opens About at the updates section for the legacy destination', () => {
    render(<SettingsMenu open initialCategory="updates" onOpenChange={() => {}} />)
    expect(screen.getByRole('heading', { name: 'Sobre o Alcy' })).toBeVisible()
    expect(screen.getByTestId('update-settings')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Sobre o Alcy' })).toHaveAttribute('aria-current', 'page')
  })

  it('keeps About available without the updater', () => {
    flags.updates = false
    render(<SettingsMenu open initialCategory="updates" onOpenChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Sobre o Alcy' })).toBeEnabled()
    expect(screen.getByRole('heading', { name: 'Sobre o Alcy' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Ver novidades' })).toBeDisabled()
    expect(screen.queryByTestId('update-settings')).not.toBeInTheDocument()
  })

  it('hides the Git category and the workspace sync protection with the flag off', async () => {
    flags.localGit = false
    render(<SettingsMenu open initialCategory="git" onOpenChange={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Git' })).not.toBeInTheDocument()
    expect(getGitIdentity).not.toHaveBeenCalled()
    // Requesting it as the initial category falls back to Interface instead of an empty page.
    expect(screen.getByRole('button', { name: 'Interface' })).toHaveAttribute('aria-current', 'page')

    fireEvent.click(screen.getByRole('button', { name: 'Dados e privacidade' }))
    expect(screen.queryByText('Sincronização do workspace')).not.toBeInTheDocument()
    // Body files are protected with or without Git (spec 0163).
    expect(screen.getByText('Arquivos de corpo')).toBeInTheDocument()
  })

  it('shows the Git category and workspace sync protection with the flag on', async () => {
    render(<SettingsMenu open initialCategory="git" onOpenChange={() => {}} />)

    expect(screen.getByRole('button', { name: 'Git' })).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByText('Os commits serão assinados por Ana <ana@example.com>.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Dados e privacidade' }))
    expect(await screen.findByText('Sincronização do workspace')).toBeInTheDocument()
  })

  it('toggles imported schema suggestions immediately', async () => {
    window.localStorage.removeItem('alcy:schema-autocomplete')
    render(<SettingsMenu open initialCategory="requests" onOpenChange={() => {}} />)
    const toggle = await screen.findByRole('checkbox', { name: 'Habilitar sugestões da documentação importada' })
    expect(toggle).toBeChecked()

    fireEvent.click(toggle)

    expect(toggle).not.toBeChecked()
    expect(window.localStorage.getItem('alcy:schema-autocomplete')).toBe('false')
    window.localStorage.removeItem('alcy:schema-autocomplete')
  })

  it('opens release notes and closes settings', () => {
    const onOpenChange = vi.fn()
    const onOpenReleaseNotes = vi.fn()
    render(<SettingsMenu open initialCategory="about" onOpenChange={onOpenChange} onOpenReleaseNotes={onOpenReleaseNotes} />)

    expect(screen.getByText(`Veja o que mudou na versão ${__APP_VERSION__} do Alcy.`)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ver novidades' }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onOpenReleaseNotes).toHaveBeenCalledTimes(1)
  })

  it('disables release notes when unavailable', () => {
    render(<SettingsMenu open initialCategory="about" onOpenChange={() => {}} />)

    expect(screen.getByRole('button', { name: 'Ver novidades' })).toBeDisabled()
    expect(screen.getByText(`A versão ${__APP_VERSION__} não tem novidades registradas.`)).toBeInTheDocument()
  })

  it('opens the category requested by the shortcut', () => {
    render(<SettingsMenu open initialCategory="git" onOpenChange={() => {}} />)
    expect(screen.getByRole('dialog')).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Git' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('radio', { name: 'Claro' })).not.toBeInTheDocument()
  })

  it('opens Interface first and preserves proxy drafts across pages', async () => {
    render(<SettingsMenu open onOpenChange={() => {}} />)
    const categories = screen.getByRole('navigation', { name: 'Categorias de configuração' })
    expect(within(categories).getAllByRole('button')[0]).toHaveTextContent('Interface')
    expect(screen.getByRole('dialog')).toHaveFocus()
    expect(screen.getByRole('radio', { name: 'Português (Brasil)' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Interface' }))
    expect(screen.getByRole('radio', { name: 'Claro' })).toBeVisible()
    expect(screen.getByRole('radio', { name: 'Padrão do sistema' })).toBeVisible()
    expect(screen.queryByRole('radio', { name: 'Sistema' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Rede e certificados' }))
    await waitFor(() => expect(getProxySettings).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('radio', { name: 'Script PAC' }))
    fireEvent.change(screen.getByLabelText('URL do script'), { target: { value: 'https://corp/draft.pac' } })
    fireEvent.click(screen.getByRole('button', { name: 'Git' }))
    expect(screen.queryByRole('button', { name: 'Aplicar' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Rede e certificados' }))
    expect(screen.getByLabelText('URL do script')).toHaveValue('https://corp/draft.pac')
    expect(saveProxySettings).not.toHaveBeenCalled()
  })

  it('traps focus in visible enabled controls', async () => {
    render(<SettingsMenu open initialCategory="appearance" onOpenChange={() => {}} />)
    await waitFor(() => expect(getProxySettings).toHaveBeenCalled())
    const close = screen.getByRole('button', { name: 'Fechar' })
    const scale = screen.getByRole('slider', { name: 'Escala dos ícones' })
    close.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(scale).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(close).toHaveFocus()
  })

  it('changes language in Interface and restores scale', () => {
    render(<SettingsMenu open initialCategory="appearance" onOpenChange={() => {}} />)
    const textScale = screen.getByRole('slider', { name: 'Escala do texto' })
    const iconScale = screen.getByRole('slider', { name: 'Escala dos ícones' })
    fireEvent.change(textScale, { target: { value: '1.2' } })
    fireEvent.change(iconScale, { target: { value: '0.9' } })
    expect(textScale).toHaveValue('1.2')
    expect(iconScale).toHaveValue('0.9')
    const [resetText, resetIcon] = screen.getAllByRole('button', { name: 'Restaurar 100%' })
    fireEvent.click(resetText)
    expect(textScale).toHaveValue('1')
    expect(iconScale).toHaveValue('0.9')
    fireEvent.click(resetIcon)
    expect(iconScale).toHaveValue('1')
    expect(screen.queryByRole('button', { name: 'Idioma' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Interface' }))
    fireEvent.click(screen.getByRole('radio', { name: 'English' }))
    expect(screen.getByRole('heading', { name: 'Interface' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Network & certificates' })).toBeVisible()
  })
})

describe('SettingsMenu — certificate verification', () => {
  it('verifies certificates by default and warns when disabled', async () => {
    saveTlsSettings.mockResolvedValue({ ok: true, value: { verifyCertificates: false } })
    renderOpen()

    const verify = screen.getByRole('checkbox', { name: 'Verificar certificados SSL' })
    await waitFor(() => expect(verify).toBeEnabled())
    expect(verify).toBeChecked()
    expect(screen.queryByText(/aceitarão qualquer certificado/)).not.toBeInTheDocument()

    fireEvent.click(verify)

    await waitFor(() => expect(saveTlsSettings).toHaveBeenCalledWith({ verifyCertificates: false }))
    await waitFor(() => expect(verify).not.toBeChecked())
    expect(screen.getByText(/aceitarão qualquer certificado/)).toBeVisible()
  })

  it('keeps verification enabled when saving fails', async () => {
    saveTlsSettings.mockResolvedValue({ ok: false, error: { kind: 'storage', message: 'disco cheio' } })
    renderOpen()

    const verify = screen.getByRole('checkbox', { name: 'Verificar certificados SSL' })
    await waitFor(() => expect(verify).toBeEnabled())
    fireEvent.click(verify)

    expect(await screen.findByText('Não foi possível salvar a preferência: disco cheio')).toBeVisible()
    expect(verify).toBeChecked()
  })
})

describe('SettingsMenu — security', () => {
  it('redacts HAR data by default and warns on opt-out', () => {
    render(<SettingsMenu open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dados e privacidade' }))
    expect(screen.getByRole('heading', { name: 'Dados e privacidade' })).toBeVisible()

    const redact = screen.getByRole('checkbox', { name: 'Ocultar dados sensíveis no HAR' })
    expect(redact).toBeChecked()
    expect(screen.queryByText(/Os dados sensíveis aparecerão/)).not.toBeInTheDocument()

    fireEvent.click(redact)
    expect(redact).not.toBeChecked()
    expect(screen.getByText(/Os dados sensíveis aparecerão/)).toBeVisible()
    expect(window.localStorage.getItem('alcy:security:har-redact-sensitive')).toBe('false')
  })

  it('protects sensitive values by default and warns on opt-out', async () => {
    saveSecuritySettings.mockResolvedValue({ ok: true, value: { syncSensitiveValues: true } })
    render(<SettingsMenu open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dados e privacidade' }))

    const protect = screen.getByRole('checkbox', { name: 'Não enviar valores sensíveis' })
    await waitFor(() => expect(protect).toBeEnabled())
    expect(protect).toBeChecked()
    expect(screen.queryByText(/serão enviados em texto claro/)).not.toBeInTheDocument()

    fireEvent.click(protect)

    await waitFor(() => expect(saveSecuritySettings).toHaveBeenCalledWith({ syncSensitiveValues: true }))
    await waitFor(() => expect(protect).not.toBeChecked())
    expect(screen.getByText(/serão enviados em texto claro/)).toBeVisible()
  })

  it('blocks body files outside the workspace by default and warns when allowed', async () => {
    saveSecuritySettings.mockResolvedValue({
      ok: true,
      value: { syncSensitiveValues: false, allowBodyFilesOutsideWorkspace: true },
    })
    render(<SettingsMenu open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dados e privacidade' }))

    const allow = screen.getByRole('checkbox', { name: 'Permitir arquivos fora do workspace' })
    await waitFor(() => expect(allow).toBeEnabled())
    expect(allow).not.toBeChecked()
    expect(screen.queryByText(/poderão enviar qualquer arquivo/)).not.toBeInTheDocument()

    fireEvent.click(allow)

    await waitFor(() => expect(saveSecuritySettings).toHaveBeenCalledWith({ allowBodyFilesOutsideWorkspace: true }))
    await waitFor(() => expect(allow).toBeChecked())
    expect(screen.getByText(/poderão enviar qualquer arquivo/)).toBeVisible()
  })

  it('shows errors saving sensitive value protection', async () => {
    saveSecuritySettings.mockResolvedValue({ ok: false, error: { kind: 'storage', message: 'disco cheio' } })
    render(<SettingsMenu open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dados e privacidade' }))

    const protect = screen.getByRole('checkbox', { name: 'Não enviar valores sensíveis' })
    await waitFor(() => expect(protect).toBeEnabled())
    fireEvent.click(protect)

    expect(await screen.findByText('Não foi possível salvar a preferência: disco cheio')).toBeVisible()
    expect(protect).toBeChecked()
  })
})

describe('SettingsMenu — general preferences', () => {
  it('shows the saved timeout and disables Apply without changes', async () => {
    render(<SettingsMenu open initialCategory="requests" onOpenChange={() => {}} />)
    const seconds = await screen.findByRole('spinbutton', { name: 'Timeout em segundos' })
    await waitFor(() => expect(seconds).toBeEnabled())
    expect(seconds).toHaveValue(60)
    expect(screen.getByRole('checkbox', { name: 'Desabilitar timeout' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Aplicar' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Restaurar padrão' })).toBeDisabled()
  })

  it('applies a new timeout in seconds', async () => {
    saveGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: 15, responseSizeLimitMb: 50, historyRetentionDays: 7, saveHistoryResponses: false, k6ImportLimitKb: 512 } })
    render(<SettingsMenu open initialCategory="requests" onOpenChange={() => {}} />)
    const seconds = await screen.findByRole('spinbutton', { name: 'Timeout em segundos' })
    await waitFor(() => expect(seconds).toBeEnabled())

    fireEvent.change(seconds, { target: { value: '15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    await waitFor(() => expect(saveGeneralSettings).toHaveBeenCalledWith({ requestTimeoutSeconds: 15, responseSizeLimitMb: 50, historyRetentionDays: 7, saveHistoryResponses: false, k6ImportLimitKb: 512 }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Aplicar' })).toBeDisabled())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('disables timeout', async () => {
    saveGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: null, responseSizeLimitMb: 50, historyRetentionDays: 7, saveHistoryResponses: false, k6ImportLimitKb: 512 } })
    render(<SettingsMenu open initialCategory="requests" onOpenChange={() => {}} />)
    const seconds = await screen.findByRole('spinbutton', { name: 'Timeout em segundos' })
    await waitFor(() => expect(seconds).toBeEnabled())

    fireEvent.click(screen.getByRole('checkbox', { name: 'Desabilitar timeout' }))
    expect(seconds).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    await waitFor(() => expect(saveGeneralSettings).toHaveBeenCalledWith({ requestTimeoutSeconds: null, responseSizeLimitMb: 50, historyRetentionDays: 7, saveHistoryResponses: false, k6ImportLimitKb: 512 }))
  })

  it('restores the default from a disabled timeout', async () => {
    getGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: null, responseSizeLimitMb: 50, historyRetentionDays: 7, saveHistoryResponses: false, k6ImportLimitKb: 512 } })
    render(<SettingsMenu open initialCategory="requests" onOpenChange={() => {}} />)
    const disable = await screen.findByRole('checkbox', { name: 'Desabilitar timeout' })
    await waitFor(() => expect(disable).toBeChecked())

    fireEvent.click(screen.getByRole('button', { name: 'Restaurar padrão' }))

    expect(disable).not.toBeChecked()
    expect(screen.getByRole('spinbutton', { name: 'Timeout em segundos' })).toHaveValue(60)
    expect(screen.getByRole('button', { name: 'Aplicar' })).toBeEnabled()
  })

  it('rejects values outside the allowed range', async () => {
    render(<SettingsMenu open initialCategory="requests" onOpenChange={() => {}} />)
    const seconds = await screen.findByRole('spinbutton', { name: 'Timeout em segundos' })
    await waitFor(() => expect(seconds).toBeEnabled())

    for (const value of ['0', '3601', '']) {
      fireEvent.change(seconds, { target: { value } })
      expect(screen.getByText('Informe um número inteiro entre 1 e 3600 segundos.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Aplicar' })).toBeDisabled()
    }
  })

  it('shows timeout save errors', async () => {
    saveGeneralSettings.mockResolvedValue({ ok: false, error: { kind: 'storage', message: 'disco cheio' } })
    render(<SettingsMenu open initialCategory="requests" onOpenChange={() => {}} />)
    const seconds = await screen.findByRole('spinbutton', { name: 'Timeout em segundos' })
    await waitFor(() => expect(seconds).toBeEnabled())

    fireEvent.change(seconds, { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    expect(await screen.findByText('Não foi possível salvar o timeout: disco cheio')).toBeInTheDocument()
  })

  it('applies a response limit while preserving timeout', async () => {
    saveGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: 60, responseSizeLimitMb: 10, historyRetentionDays: 7, saveHistoryResponses: false, k6ImportLimitKb: 512 } })
    render(<SettingsMenu open initialCategory="requests" onOpenChange={() => {}} />)
    const megabytes = await screen.findByRole('spinbutton', { name: 'Limite de resposta em MB' })
    await waitFor(() => expect(megabytes).toBeEnabled())
    expect(megabytes).toHaveValue(50)

    fireEvent.change(megabytes, { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar limite de resposta' }))

    await waitFor(() => expect(saveGeneralSettings).toHaveBeenCalledWith({ requestTimeoutSeconds: 60, responseSizeLimitMb: 10, historyRetentionDays: 7, saveHistoryResponses: false, k6ImportLimitKb: 512 }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Aplicar limite de resposta' })).toBeDisabled())
  })

  it('applies a k6 import limit that cannot be disabled and rejects out-of-range values', async () => {
    saveGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: 60, responseSizeLimitMb: 50, historyRetentionDays: 7, saveHistoryResponses: false, k6ImportLimitKb: 1024 } })
    render(<SettingsMenu open initialCategory="requests" onOpenChange={() => {}} />)
    const kilobytes = await screen.findByRole('spinbutton', { name: 'Limite de importação de scripts k6 em KB' })
    await waitFor(() => expect(kilobytes).toBeEnabled())
    expect(kilobytes).toHaveValue(512)
    const section = screen.getByTestId('k6-import-limit-settings')
    expect(within(section).queryByRole('checkbox')).not.toBeInTheDocument()
    const apply = screen.getByRole('button', { name: 'Aplicar limite de importação k6' })

    for (const invalid of ['0', '2049']) {
      fireEvent.change(kilobytes, { target: { value: invalid } })
      expect(await within(section).findByText('Informe um número inteiro entre 1 e 2048 KB.')).toBeInTheDocument()
      expect(apply).toBeDisabled()
    }

    fireEvent.change(kilobytes, { target: { value: '1024' } })
    fireEvent.click(apply)

    await waitFor(() => expect(saveGeneralSettings).toHaveBeenCalledWith({ requestTimeoutSeconds: 60, responseSizeLimitMb: 50, historyRetentionDays: 7, saveHistoryResponses: false, k6ImportLimitKb: 1024 }))
  })

  it('preserves the response limit when applying timeout', async () => {
    getGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: 60, responseSizeLimitMb: 200, historyRetentionDays: 7, saveHistoryResponses: false, k6ImportLimitKb: 512 } })
    saveGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: 30, responseSizeLimitMb: 200, historyRetentionDays: 7, saveHistoryResponses: false, k6ImportLimitKb: 512 } })
    render(<SettingsMenu open initialCategory="requests" onOpenChange={() => {}} />)
    const seconds = await screen.findByRole('spinbutton', { name: 'Timeout em segundos' })
    await waitFor(() => expect(seconds).toBeEnabled())

    fireEvent.change(seconds, { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    await waitFor(() => expect(saveGeneralSettings).toHaveBeenCalledWith({ requestTimeoutSeconds: 30, responseSizeLimitMb: 200, historyRetentionDays: 7, saveHistoryResponses: false, k6ImportLimitKb: 512 }))
    expect(screen.getByRole('spinbutton', { name: 'Limite de resposta em MB' })).toHaveValue(200)
  })

  it('disables the response limit', async () => {
    saveGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: 60, responseSizeLimitMb: null, historyRetentionDays: 7, saveHistoryResponses: false, k6ImportLimitKb: 512 } })
    render(<SettingsMenu open initialCategory="requests" onOpenChange={() => {}} />)
    const megabytes = await screen.findByRole('spinbutton', { name: 'Limite de resposta em MB' })
    await waitFor(() => expect(megabytes).toBeEnabled())

    fireEvent.click(screen.getByRole('checkbox', { name: 'Desabilitar limite' }))
    expect(megabytes).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar limite de resposta' }))

    await waitFor(() => expect(saveGeneralSettings).toHaveBeenCalledWith({ requestTimeoutSeconds: 60, responseSizeLimitMb: null, historyRetentionDays: 7, saveHistoryResponses: false, k6ImportLimitKb: 512 }))
  })

  it('reduces history retention and requests a history reload', async () => {
    saveGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: 60, responseSizeLimitMb: 50, historyRetentionDays: 3, saveHistoryResponses: false, k6ImportLimitKb: 512 } })
    const onHistoryRetentionChange = vi.fn()
    render(<SettingsMenu open initialCategory="privacy" onOpenChange={() => {}} onHistoryRetentionChange={onHistoryRetentionChange} />)
    const days = await screen.findByRole('spinbutton', { name: 'Retenção do histórico em dias' })
    await waitFor(() => expect(days).toBeEnabled())
    expect(days).toHaveValue(7)

    fireEvent.change(days, { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar retenção do histórico' }))

    await waitFor(() => expect(saveGeneralSettings).toHaveBeenCalledWith({ requestTimeoutSeconds: 60, responseSizeLimitMb: 50, historyRetentionDays: 3, saveHistoryResponses: false, k6ImportLimitKb: 512 }))
    await waitFor(() => expect(onHistoryRetentionChange).toHaveBeenCalledTimes(1))
  })

  it('saves zero days when history is disabled', async () => {
    saveGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: 60, responseSizeLimitMb: 50, historyRetentionDays: 0, saveHistoryResponses: false, k6ImportLimitKb: 512 } })
    render(<SettingsMenu open initialCategory="privacy" onOpenChange={() => {}} />)
    const days = await screen.findByRole('spinbutton', { name: 'Retenção do histórico em dias' })
    await waitFor(() => expect(days).toBeEnabled())

    fireEvent.click(screen.getByRole('checkbox', { name: 'Desativar histórico' }))
    expect(days).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar retenção do histórico' }))

    await waitFor(() => expect(saveGeneralSettings).toHaveBeenCalledWith({ requestTimeoutSeconds: 60, responseSizeLimitMb: 50, historyRetentionDays: 0, saveHistoryResponses: false, k6ImportLimitKb: 512 }))
  })

  it('shows history disabled for zero saved retention', async () => {
    getGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: 60, responseSizeLimitMb: 50, historyRetentionDays: 0, saveHistoryResponses: false, k6ImportLimitKb: 512 } })
    render(<SettingsMenu open initialCategory="privacy" onOpenChange={() => {}} />)

    const disable = await screen.findByRole('checkbox', { name: 'Desativar histórico' })
    await waitFor(() => expect(disable).toBeChecked())
    expect(screen.getByRole('spinbutton', { name: 'Retenção do histórico em dias' })).toBeDisabled()
  })

  it('rejects history retention above seven days', async () => {
    render(<SettingsMenu open initialCategory="privacy" onOpenChange={() => {}} />)
    const days = await screen.findByRole('spinbutton', { name: 'Retenção do histórico em dias' })
    await waitFor(() => expect(days).toBeEnabled())

    fireEvent.change(days, { target: { value: '8' } })

    expect(screen.getByText(/Informe um número inteiro entre 1 e 7 dias/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Aplicar retenção do histórico' })).toBeDisabled()
  })

  it('keeps history responses off by default and enables them immediately', async () => {
    saveGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: 60, responseSizeLimitMb: 50, historyRetentionDays: 7, saveHistoryResponses: true, k6ImportLimitKb: 512 } })
    render(<SettingsMenu open initialCategory="privacy" onOpenChange={() => {}} />)
    const toggle = await screen.findByRole('checkbox', { name: 'Salvar respostas no histórico' })
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).not.toBeChecked()

    fireEvent.click(toggle)

    await waitFor(() =>
      expect(saveGeneralSettings).toHaveBeenCalledWith({ requestTimeoutSeconds: 60, responseSizeLimitMb: 50, historyRetentionDays: 7, saveHistoryResponses: true, k6ImportLimitKb: 512 }),
    )
    await waitFor(() => expect(toggle).toBeChecked())
  })

  it('shows timeout loading errors', async () => {
    getGeneralSettings.mockResolvedValue({ ok: false, error: { kind: 'storage', message: 'arquivo corrompido' } })
    render(<SettingsMenu open initialCategory="requests" onOpenChange={() => {}} />)

    expect(await screen.findByText('Não foi possível carregar o timeout salvo: arquivo corrompido')).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Timeout em segundos' })).toBeDisabled()
  })
})

describe('SettingsMenu — shortcuts', () => {
  const openShortcuts = (onOpenChange: (open: boolean) => void = () => {}) => {
    render(<SettingsMenu open onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Atalhos' }))
  }
  const capture = () => screen.getByRole('textbox', { name: 'Combinação de teclas' })
  const stored = () => JSON.parse(window.localStorage.getItem('alcy:shortcuts') ?? 'null')
  const captureClosed = (action: string) =>
    waitFor(() => expect(screen.queryByRole('dialog', { name: `Atalho de ${action}` })).not.toBeInTheDocument())

  it('lists actions with default shortcuts', () => {
    openShortcuts()
    const table = screen.getByRole('table')
    const [head, ...groups] = within(table).getAllByRole('rowgroup')
    expect(within(head).getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Ação',
      'Atalho',
      'Alternativo',
      'Opções',
    ])
    expect(groups.map((group) => group.querySelector('.settings-shortcuts-group')?.textContent)).toEqual([
      'Requisições',
      'Abas',
      'Collections',
      'Item selecionado na barra lateral',
      'Interface',
      'Editores',
      'Flows',
    ])
    const sendRow = within(table).getByRole('rowheader', { name: 'Enviar requisição' }).closest('tr')!
    expect(within(sendRow).getByRole('button', { name: 'Alterar atalho Enter de Enviar requisição' })).toBeVisible()
    expect(within(sendRow).getByRole('button', { name: 'Alterar atalho Ctrl+Enter de Enviar requisição' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Alterar atalho Ctrl+S de Salvar requisição' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Adicionar atalho para Salvar requisição' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Alterar atalho Ctrl+W de Fechar aba' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Alterar atalho Ctrl+D de Duplicar requisição selecionada' })).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Alterar atalho Delete de Remover item selecionado (collections, flows e monitores)' }),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Alterar atalho Ctrl+Tab de Próxima aba' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Alterar atalho Ctrl+Shift+Tab de Aba anterior' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Restaurar todos os padrões' })).toBeDisabled()
  })

  it('filters shortcuts by action and group ignoring accents, and clears without closing settings', () => {
    const onOpenChange = vi.fn()
    openShortcuts(onOpenChange)
    const search = screen.getByRole('searchbox', { name: 'Buscar ação, grupo ou combinação…' })
    const allRows = screen.getAllByRole('rowheader').length
    fireEvent.change(search, { target: { value: 'PROXIMA' } })
    expect(screen.getAllByRole('rowheader')).toHaveLength(1)
    expect(screen.getByRole('rowheader', { name: 'Próxima aba' })).toBeVisible()
    fireEvent.change(search, { target: { value: 'REQUISICOES' } })
    expect(screen.getAllByRole('rowheader').map((row) => row.textContent)).toEqual(['Enviar requisição', 'Salvar requisição', 'Nova requisição'])
    expect(screen.queryByText('Flows', { selector: 'th' })).not.toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'no-matching-shortcuts' } })
    expect(screen.getByRole('status')).toHaveTextContent('Nenhum atalho encontrado. Tente outro termo.')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(search).toHaveValue('')
    expect(screen.getAllByRole('rowheader')).toHaveLength(allRows)
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(stored()).toBeNull()
  })

  it('searches current combinations and returns focus to search if editing removes the match', async () => {
    openShortcuts()
    const search = screen.getByRole('searchbox', { name: 'Buscar ação, grupo ou combinação…' })
    fireEvent.change(search, { target: { value: 'ctrl + s' } })
    expect(screen.getAllByRole('rowheader')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Alterar atalho Ctrl+S de Salvar requisição' }))
    fireEvent.keyDown(capture(), { key: 'F4' })
    fireEvent.keyDown(capture(), { key: 'Enter' })
    await captureClosed('Salvar requisição')
    expect(search).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent('Nenhum atalho encontrado.')
    fireEvent.change(search, { target: { value: 'f4' } })
    expect(screen.getByRole('button', { name: 'Alterar atalho F4 de Salvar requisição' })).toBeVisible()
    fireEvent.click(within(screen.getByTestId('shortcut-settings')).getByRole('button', { name: 'Limpar busca' }))
    expect(search).toHaveValue('')
    expect(search).toHaveFocus()
    expect(stored().bindings.saveRequest).toEqual(['F4'])
  })

  it('records a mouse button only for the blocks menu shortcut', async () => {
    openShortcuts()
    expect(screen.queryByLabelText('Área para gravar um botão do mouse')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Alterar atalho Botão direito de Abrir menu de blocos (flows)' }))

    fireEvent.mouseDown(screen.getByLabelText('Área para gravar um botão do mouse'), { button: 2, ctrlKey: true })
    expect(capture()).toHaveValue('Ctrl+Botão direito')
    expect(capture()).toHaveFocus()
    fireEvent.keyDown(capture(), { key: 'Enter' })
    await captureClosed('Abrir menu de blocos (flows)')

    expect(screen.getByRole('button', { name: 'Alterar atalho Ctrl+Botão direito de Abrir menu de blocos (flows)' })).toBeVisible()
    expect(stored()).toEqual({ version: 1, bindings: { openBlockPalette: ['Ctrl+MouseRight'] } })

    fireEvent.click(screen.getByRole('button', { name: 'Alterar atalho Ctrl+S de Salvar requisição' }))
    expect(screen.queryByLabelText('Área para gravar um botão do mouse')).toBeNull()
  })

  it('edits shortcuts and adds removes and restores alternatives', async () => {
    openShortcuts()
    fireEvent.click(screen.getByRole('button', { name: 'Alterar atalho Ctrl+S de Salvar requisição' }))
    expect(screen.getByRole('dialog', { name: 'Atalho de Salvar requisição' })).toBeVisible()
    expect(capture()).toHaveFocus()
    fireEvent.keyDown(capture(), { key: 'Control', ctrlKey: true })
    expect(capture()).toHaveValue('')
    fireEvent.keyDown(capture(), { key: 'F4' })
    expect(capture()).toHaveValue('F4')
    fireEvent.keyDown(capture(), { key: 'Enter' })
    await captureClosed('Salvar requisição')
    expect(screen.getByRole('button', { name: 'Alterar atalho F4 de Salvar requisição' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar atalho para Salvar requisição' }))
    fireEvent.keyDown(capture(), { key: 'S', ctrlKey: true, shiftKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }))
    await captureClosed('Salvar requisição')
    expect(stored()).toEqual({ version: 1, bindings: { saveRequest: ['F4', 'Ctrl+Shift+S'] } })
    expect(screen.queryByRole('button', { name: 'Adicionar atalho para Salvar requisição' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remover atalho F4 de Salvar requisição' }))
    expect(stored().bindings.saveRequest).toEqual(['Ctrl+Shift+S'])

    fireEvent.click(screen.getByRole('button', { name: 'Restaurar padrão de Salvar requisição' }))
    expect(screen.getByRole('button', { name: 'Alterar atalho Ctrl+S de Salvar requisição' })).toBeVisible()
    expect(stored()).toBeNull()
  })

  it('captures Enter first and confirms on the next Enter', async () => {
    openShortcuts()
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar atalho para Próxima aba' }))
    fireEvent.keyDown(capture(), { key: 'F6' })
    fireEvent.keyDown(capture(), { key: 'Enter' })
    await captureClosed('Próxima aba')
    expect(stored().bindings.nextTab).toEqual(['Ctrl+Tab', 'F6'])

    fireEvent.click(screen.getByRole('button', { name: 'Alterar atalho F6 de Próxima aba' }))
    fireEvent.keyDown(capture(), { key: 'Enter' })
    expect(capture()).toHaveValue('Enter')
    expect(screen.getByRole('alert')).toHaveTextContent('Enter já é usado por Enviar requisição.')
    expect(screen.getByRole('button', { name: 'Substituir' })).toBeEnabled()
  })

  it('warns about shortcut conflicts and moves the binding when replaced', async () => {
    openShortcuts()
    fireEvent.click(screen.getByRole('button', { name: 'Alterar atalho Enter de Enviar requisição' }))
    fireEvent.keyDown(capture(), { key: 's', ctrlKey: true })
    expect(screen.getByRole('alert')).toHaveTextContent('Ctrl+S já é usado por Salvar requisição.')
    fireEvent.click(screen.getByRole('button', { name: 'Substituir' }))
    await captureClosed('Enviar requisição')

    expect(screen.getByRole('button', { name: 'Alterar atalho Ctrl+S de Enviar requisição' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Adicionar atalho para Salvar requisição' })).toBeVisible()
    expect(stored()).toEqual({ version: 1, bindings: { sendRequest: ['Ctrl+S', 'Ctrl+Enter'], saveRequest: [] } })
  })

  it('closes only the capture modal with Escape without saving', async () => {
    const onOpenChange = vi.fn()
    openShortcuts(onOpenChange)
    fireEvent.click(screen.getByRole('button', { name: 'Alterar atalho Ctrl+Tab de Próxima aba' }))
    fireEvent.keyDown(capture(), { key: 'Escape' })
    await captureClosed('Próxima aba')

    // When focus is outside the capture field, the modal stack handles Escape.
    fireEvent.click(screen.getByRole('button', { name: 'Alterar atalho Ctrl+Tab de Próxima aba' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancelar' }), { key: 'Escape' })
    await captureClosed('Próxima aba')

    expect(screen.getByRole('dialog', { name: 'Configurações' })).toBeVisible()
    expect(document.querySelector('.ui-modal-backdrop--closing')).toBeNull()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(stored()).toBeNull()
  })

  it('rejects reserved unmodified and duplicate shortcuts', () => {
    openShortcuts()
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar atalho para Salvar requisição' }))
    fireEvent.keyDown(capture(), { key: 'c', ctrlKey: true })
    expect(screen.getByRole('alert')).toHaveTextContent('Ctrl+C é reservado para edição de texto')
    expect(screen.getByRole('button', { name: 'Confirmar' })).toBeDisabled()

    fireEvent.keyDown(capture(), { key: 'a' })
    expect(screen.getByRole('alert')).toHaveTextContent('Somente Ctrl, Alt, Enter e as teclas F1 a F12')

    fireEvent.keyDown(capture(), { key: 'Delete' })
    expect(screen.getByRole('alert')).toHaveTextContent('Somente Ctrl, Alt, Enter e as teclas F1 a F12')

    fireEvent.keyDown(capture(), { key: 's', ctrlKey: true })
    expect(screen.getByRole('alert')).toHaveTextContent('Ctrl+S já é um atalho desta ação.')
    expect(screen.getByRole('button', { name: 'Confirmar' })).toBeDisabled()
    expect(stored()).toBeNull()
  })
})
