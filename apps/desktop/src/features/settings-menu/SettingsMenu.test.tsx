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
const flags = vi.hoisted(() => ({ updates: true, gitlab: true }))

vi.mock('../../shared/feature-flags', () => ({ FEATURE_FLAGS: flags }))

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
  flags.gitlab = true
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
  getGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: 60, responseSizeLimitMb: 50, historyRetentionDays: 7, saveHistoryResponses: false } })
  getSecuritySettings.mockReset()
  saveSecuritySettings.mockReset()
  getSecuritySettings.mockResolvedValue({ ok: true, value: { syncSensitiveValues: false } })
})

const renderOpen = () => {
  const result = render(<SettingsMenu open onOpenChange={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Rede' }))
  return result
}

describe('SettingsMenu — proxy', () => {
  it('só mostra o campo de URL no modo PAC e mantém "Aplicar" desabilitado sem mudanças', async () => {
    renderOpen()
    const apply = await screen.findByRole('button', { name: 'Aplicar' })
    expect(apply).toBeDisabled()
    expect(screen.queryByLabelText('URL do script')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Script PAC' }))
    expect(screen.getByLabelText('URL do script')).toBeInTheDocument()
    expect(apply).toBeDisabled() // URL vazia

    fireEvent.change(screen.getByLabelText('URL do script'), { target: { value: 'https://corp/p.pac' } })
    expect(apply).toBeEnabled()
  })

  it('aplica o proxy do sistema', async () => {
    saveProxySettings.mockResolvedValue({ ok: true, value: { mode: 'system', pacUrl: null, error: null } })
    renderOpen()

    fireEvent.click(await screen.findByRole('radio', { name: 'Sistema' }))
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    await waitFor(() => expect(saveProxySettings).toHaveBeenCalledWith({ mode: 'system', pacUrl: null }))
    expect(await screen.findByText('Configuração de proxy aplicada.')).toBeInTheDocument()
  })

  it('testa o script PAC e mostra o erro devolvido', async () => {
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

  it('reflete a configuração salva, mesmo carregada depois de o modal abrir', async () => {
    getProxySettings.mockResolvedValue({ ok: true, value: { mode: 'pac', pacUrl: 'https://corp/p.pac', error: null } })
    renderOpen()

    expect(await screen.findByDisplayValue('https://corp/p.pac')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Script PAC' })).toBeChecked()
  })

  it('avisa quando a configuração salva não pôde ser aplicada', async () => {
    getProxySettings.mockResolvedValue({
      ok: true,
      value: { mode: 'pac', pacUrl: 'https://corp/p.pac', error: 'resposta HTTP 500' },
    })
    renderOpen()

    expect(await screen.findByRole('alert')).toHaveTextContent('resposta HTTP 500')
  })
})


describe('SettingsMenu — tooltip do botão', () => {
  it('não mostra o tooltip do botão ao passar o mouse sobre o modal aberto', async () => {
    render(<SettingsMenu open onOpenChange={() => {}} />)
    // Eventos de mouse do React atravessam o portal do modal até os ancestrais.
    fireEvent.mouseEnter(screen.getByRole('dialog'))
    await new Promise((resolve) => setTimeout(resolve, TOOLTIP_DELAY_MS + 50))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('mostra o tooltip ao passar o mouse sobre o botão', async () => {
    render(<SettingsMenu open={false} onOpenChange={() => {}} />)
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Configurações' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Configurações')
  })
})

describe('SettingsMenu — categorias', () => {
  it('abre a aba de atualizações na categoria inicial pedida', () => {
    render(<SettingsMenu open initialCategory="updates" onOpenChange={() => {}} />)
    expect(screen.getByRole('heading', { name: 'Atualizações' })).toBeVisible()
    expect(screen.getByTestId('update-settings')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Atualizações' })).toHaveAttribute('aria-current', 'page')
  })

  it('desabilita a aba de atualizações com a feature flag desligada e explica no tooltip', async () => {
    flags.updates = false
    render(<SettingsMenu open onOpenChange={() => {}} />)
    const updates = screen.getByRole('button', { name: 'Atualizações' })
    expect(updates).toBeDisabled()
    // O botão desabilitado não recebe o hover: quem dispara o tooltip é o host.
    fireEvent.mouseEnter(updates.parentElement!)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Funcionalidade desabilitada')
    fireEvent.click(updates)
    expect(screen.getByRole('button', { name: 'Geral' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByTestId('update-settings')).not.toBeInTheDocument()
  })

  it('esconde as abas dos providers com as feature flags desligadas e some com a sincronização da segurança', async () => {
    flags.gitlab = false
    render(<SettingsMenu open initialCategory="gitlab" onOpenChange={() => {}} />)
    expect(screen.queryByRole('button', { name: 'GitLab' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'OneDrive' })).not.toBeInTheDocument()
    // Pedida como categoria inicial, cai em "Geral" em vez de abrir uma página vazia.
    expect(screen.getByRole('button', { name: 'Geral' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByTestId('gitlab-settings')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Segurança' }))
    expect(screen.queryByText('Sincronização do workspace')).not.toBeInTheDocument()
    expect(getSecuritySettings).not.toHaveBeenCalled()
  })

  it('liga e desliga as sugestões da documentação importada na hora, sem "Aplicar"', async () => {
    window.localStorage.removeItem('alcy:schema-autocomplete')
    render(<SettingsMenu open onOpenChange={() => {}} />)
    const toggle = await screen.findByRole('checkbox', { name: 'Habilitar sugestões da documentação importada' })
    expect(toggle).toBeChecked()

    fireEvent.click(toggle)

    expect(toggle).not.toBeChecked()
    expect(window.localStorage.getItem('alcy:schema-autocomplete')).toBe('false')
    window.localStorage.removeItem('alcy:schema-autocomplete')
  })

  it('abre as novidades da versão e fecha as configurações', () => {
    const onOpenChange = vi.fn()
    const onOpenReleaseNotes = vi.fn()
    render(<SettingsMenu open onOpenChange={onOpenChange} onOpenReleaseNotes={onOpenReleaseNotes} />)

    expect(screen.getByText(`Veja o que mudou na versão ${__APP_VERSION__} do Alcy.`)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ver novidades' }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onOpenReleaseNotes).toHaveBeenCalledTimes(1)
  })

  it('desabilita as novidades quando a versão não tem notas', () => {
    render(<SettingsMenu open onOpenChange={() => {}} />)

    expect(screen.getByRole('button', { name: 'Ver novidades' })).toBeDisabled()
    expect(screen.getByText(`A versão ${__APP_VERSION__} não tem novidades registradas.`)).toBeInTheDocument()
  })

  it('abre diretamente na categoria solicitada pelo atalho', () => {
    render(<SettingsMenu open initialCategory="gitlab" onOpenChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'GitLab' })).toHaveFocus()
    expect(screen.getByTestId('gitlab-settings')).toBeVisible()
    expect(screen.queryByRole('radio', { name: 'Claro' })).not.toBeInTheDocument()
  })

  it('abre em Geral, a primeira categoria, e alterna categorias sem perder o rascunho do proxy', async () => {
    render(<SettingsMenu open onOpenChange={() => {}} />)
    const categories = screen.getByRole('navigation', { name: 'Categorias de configuração' })
    expect(within(categories).getAllByRole('button')[0]).toHaveTextContent('Geral')
    expect(screen.getByRole('button', { name: 'Geral' })).toHaveFocus()
    expect(await screen.findByTestId('general-settings')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Aparência' }))
    expect(screen.getByRole('radio', { name: 'Claro' })).toBeVisible()
    expect(screen.queryByRole('radio', { name: 'Sistema' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Rede' }))
    await waitFor(() => expect(getProxySettings).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('radio', { name: 'Script PAC' }))
    fireEvent.change(screen.getByLabelText('URL do script'), { target: { value: 'https://corp/draft.pac' } })
    fireEvent.click(screen.getByRole('button', { name: 'GitLab' }))
    expect(screen.queryByRole('button', { name: 'Aplicar' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Rede' }))
    expect(screen.getByLabelText('URL do script')).toHaveValue('https://corp/draft.pac')
    expect(saveProxySettings).not.toHaveBeenCalled()
  })

  it('mantém o ciclo de foco nos controles visíveis e habilitados', async () => {
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

  it('permite mudar idioma em Geral e restaurar a escala', () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Geral' }))
    fireEvent.click(screen.getByRole('radio', { name: 'English' }))
    expect(screen.getByRole('heading', { name: 'General' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Network' })).toBeVisible()
  })
})

describe('SettingsMenu — verificação de certificado', () => {
  it('verifica certificados por padrão e salva a desativação com aviso', async () => {
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

  it('mantém a verificação marcada quando salvar falha', async () => {
    saveTlsSettings.mockResolvedValue({ ok: false, error: { kind: 'storage', message: 'disco cheio' } })
    renderOpen()

    const verify = screen.getByRole('checkbox', { name: 'Verificar certificados SSL' })
    await waitFor(() => expect(verify).toBeEnabled())
    fireEvent.click(verify)

    expect(await screen.findByText('Não foi possível salvar a preferência: disco cheio')).toBeVisible()
    expect(verify).toBeChecked()
  })
})

describe('SettingsMenu — segurança', () => {
  it('oculta dados sensíveis do HAR por padrão e permite o opt-out com aviso', () => {
    render(<SettingsMenu open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Segurança' }))
    expect(screen.getByRole('heading', { name: 'Segurança' })).toBeVisible()

    const redact = screen.getByRole('checkbox', { name: 'Ocultar dados sensíveis no HAR' })
    expect(redact).toBeChecked()
    expect(screen.queryByText(/Os dados sensíveis aparecerão/)).not.toBeInTheDocument()

    fireEvent.click(redact)
    expect(redact).not.toBeChecked()
    expect(screen.getByText(/Os dados sensíveis aparecerão/)).toBeVisible()
    expect(window.localStorage.getItem('alcy:security:har-redact-sensitive')).toBe('false')
  })

  it('não envia valores sensíveis ao GitLab por padrão e salva o opt-out com aviso', async () => {
    saveSecuritySettings.mockResolvedValue({ ok: true, value: { syncSensitiveValues: true } })
    render(<SettingsMenu open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Segurança' }))

    const protect = screen.getByRole('checkbox', { name: 'Não enviar valores de variáveis sensíveis' })
    await waitFor(() => expect(protect).toBeEnabled())
    expect(protect).toBeChecked()
    expect(screen.queryByText(/serão enviados em texto claro/)).not.toBeInTheDocument()

    fireEvent.click(protect)

    await waitFor(() => expect(saveSecuritySettings).toHaveBeenCalledWith({ syncSensitiveValues: true }))
    await waitFor(() => expect(protect).not.toBeChecked())
    expect(screen.getByText(/serão enviados em texto claro/)).toBeVisible()
  })

  it('mostra o erro ao salvar a proteção de valores sensíveis', async () => {
    saveSecuritySettings.mockResolvedValue({ ok: false, error: { kind: 'storage', message: 'disco cheio' } })
    render(<SettingsMenu open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Segurança' }))

    const protect = screen.getByRole('checkbox', { name: 'Não enviar valores de variáveis sensíveis' })
    await waitFor(() => expect(protect).toBeEnabled())
    fireEvent.click(protect)

    expect(await screen.findByText('Não foi possível salvar a preferência: disco cheio')).toBeVisible()
    expect(protect).toBeChecked()
  })
})

describe('SettingsMenu — geral', () => {
  it('mostra o timeout salvo, 60 segundos por padrão, com "Aplicar" desabilitado sem mudanças', async () => {
    render(<SettingsMenu open onOpenChange={() => {}} />)
    const seconds = await screen.findByRole('spinbutton', { name: 'Timeout em segundos' })
    await waitFor(() => expect(seconds).toBeEnabled())
    expect(seconds).toHaveValue(60)
    expect(screen.getByRole('checkbox', { name: 'Desabilitar timeout' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Aplicar' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Restaurar padrão' })).toBeDisabled()
  })

  it('aplica um novo timeout em segundos', async () => {
    saveGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: 15, responseSizeLimitMb: 50, historyRetentionDays: 7, saveHistoryResponses: false } })
    render(<SettingsMenu open onOpenChange={() => {}} />)
    const seconds = await screen.findByRole('spinbutton', { name: 'Timeout em segundos' })
    await waitFor(() => expect(seconds).toBeEnabled())

    fireEvent.change(seconds, { target: { value: '15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    await waitFor(() => expect(saveGeneralSettings).toHaveBeenCalledWith({ requestTimeoutSeconds: 15, responseSizeLimitMb: 50, historyRetentionDays: 7, saveHistoryResponses: false }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Aplicar' })).toBeDisabled())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('desabilita o timeout', async () => {
    saveGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: null, responseSizeLimitMb: 50, historyRetentionDays: 7, saveHistoryResponses: false } })
    render(<SettingsMenu open onOpenChange={() => {}} />)
    const seconds = await screen.findByRole('spinbutton', { name: 'Timeout em segundos' })
    await waitFor(() => expect(seconds).toBeEnabled())

    fireEvent.click(screen.getByRole('checkbox', { name: 'Desabilitar timeout' }))
    expect(seconds).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    await waitFor(() => expect(saveGeneralSettings).toHaveBeenCalledWith({ requestTimeoutSeconds: null, responseSizeLimitMb: 50, historyRetentionDays: 7, saveHistoryResponses: false }))
  })

  it('restaura o padrão a partir de um timeout desabilitado', async () => {
    getGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: null, responseSizeLimitMb: 50, historyRetentionDays: 7, saveHistoryResponses: false } })
    render(<SettingsMenu open onOpenChange={() => {}} />)
    const disable = await screen.findByRole('checkbox', { name: 'Desabilitar timeout' })
    await waitFor(() => expect(disable).toBeChecked())

    fireEvent.click(screen.getByRole('button', { name: 'Restaurar padrão' }))

    expect(disable).not.toBeChecked()
    expect(screen.getByRole('spinbutton', { name: 'Timeout em segundos' })).toHaveValue(60)
    expect(screen.getByRole('button', { name: 'Aplicar' })).toBeEnabled()
  })

  it('bloqueia valores fora do intervalo', async () => {
    render(<SettingsMenu open onOpenChange={() => {}} />)
    const seconds = await screen.findByRole('spinbutton', { name: 'Timeout em segundos' })
    await waitFor(() => expect(seconds).toBeEnabled())

    for (const value of ['0', '3601', '']) {
      fireEvent.change(seconds, { target: { value } })
      expect(screen.getByText('Informe um número inteiro entre 1 e 3600 segundos.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Aplicar' })).toBeDisabled()
    }
  })

  it('mostra o erro quando o timeout não pode ser salvo', async () => {
    saveGeneralSettings.mockResolvedValue({ ok: false, error: { kind: 'storage', message: 'disco cheio' } })
    render(<SettingsMenu open onOpenChange={() => {}} />)
    const seconds = await screen.findByRole('spinbutton', { name: 'Timeout em segundos' })
    await waitFor(() => expect(seconds).toBeEnabled())

    fireEvent.change(seconds, { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    expect(await screen.findByText('Não foi possível salvar o timeout: disco cheio')).toBeInTheDocument()
  })

  it('aplica um novo limite de resposta mantendo o timeout salvo', async () => {
    saveGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: 60, responseSizeLimitMb: 10, historyRetentionDays: 7, saveHistoryResponses: false } })
    render(<SettingsMenu open onOpenChange={() => {}} />)
    const megabytes = await screen.findByRole('spinbutton', { name: 'Limite de resposta em MB' })
    await waitFor(() => expect(megabytes).toBeEnabled())
    expect(megabytes).toHaveValue(50)

    fireEvent.change(megabytes, { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar limite de resposta' }))

    await waitFor(() => expect(saveGeneralSettings).toHaveBeenCalledWith({ requestTimeoutSeconds: 60, responseSizeLimitMb: 10, historyRetentionDays: 7, saveHistoryResponses: false }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Aplicar limite de resposta' })).toBeDisabled())
  })

  it('aplicar o timeout preserva o limite de resposta salvo', async () => {
    getGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: 60, responseSizeLimitMb: 200, historyRetentionDays: 7, saveHistoryResponses: false } })
    saveGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: 30, responseSizeLimitMb: 200, historyRetentionDays: 7, saveHistoryResponses: false } })
    render(<SettingsMenu open onOpenChange={() => {}} />)
    const seconds = await screen.findByRole('spinbutton', { name: 'Timeout em segundos' })
    await waitFor(() => expect(seconds).toBeEnabled())

    fireEvent.change(seconds, { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    await waitFor(() => expect(saveGeneralSettings).toHaveBeenCalledWith({ requestTimeoutSeconds: 30, responseSizeLimitMb: 200, historyRetentionDays: 7, saveHistoryResponses: false }))
    expect(screen.getByRole('spinbutton', { name: 'Limite de resposta em MB' })).toHaveValue(200)
  })

  it('desabilita o limite de resposta', async () => {
    saveGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: 60, responseSizeLimitMb: null, historyRetentionDays: 7, saveHistoryResponses: false } })
    render(<SettingsMenu open onOpenChange={() => {}} />)
    const megabytes = await screen.findByRole('spinbutton', { name: 'Limite de resposta em MB' })
    await waitFor(() => expect(megabytes).toBeEnabled())

    fireEvent.click(screen.getByRole('checkbox', { name: 'Desabilitar limite' }))
    expect(megabytes).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar limite de resposta' }))

    await waitFor(() => expect(saveGeneralSettings).toHaveBeenCalledWith({ requestTimeoutSeconds: 60, responseSizeLimitMb: null, historyRetentionDays: 7, saveHistoryResponses: false }))
  })

  it('aplica uma retenção menor do histórico e pede para recarregar o histórico', async () => {
    saveGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: 60, responseSizeLimitMb: 50, historyRetentionDays: 3, saveHistoryResponses: false } })
    const onHistoryRetentionChange = vi.fn()
    render(<SettingsMenu open onOpenChange={() => {}} onHistoryRetentionChange={onHistoryRetentionChange} />)
    const days = await screen.findByRole('spinbutton', { name: 'Retenção do histórico em dias' })
    await waitFor(() => expect(days).toBeEnabled())
    expect(days).toHaveValue(7)

    fireEvent.change(days, { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar retenção do histórico' }))

    await waitFor(() => expect(saveGeneralSettings).toHaveBeenCalledWith({ requestTimeoutSeconds: 60, responseSizeLimitMb: 50, historyRetentionDays: 3, saveHistoryResponses: false }))
    await waitFor(() => expect(onHistoryRetentionChange).toHaveBeenCalledTimes(1))
  })

  it('desativar o histórico grava zero dias', async () => {
    saveGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: 60, responseSizeLimitMb: 50, historyRetentionDays: 0, saveHistoryResponses: false } })
    render(<SettingsMenu open onOpenChange={() => {}} />)
    const days = await screen.findByRole('spinbutton', { name: 'Retenção do histórico em dias' })
    await waitFor(() => expect(days).toBeEnabled())

    fireEvent.click(screen.getByRole('checkbox', { name: 'Desativar histórico' }))
    expect(days).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar retenção do histórico' }))

    await waitFor(() => expect(saveGeneralSettings).toHaveBeenCalledWith({ requestTimeoutSeconds: 60, responseSizeLimitMb: 50, historyRetentionDays: 0, saveHistoryResponses: false }))
  })

  it('mostra o histórico desativado quando a retenção salva é zero', async () => {
    getGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: 60, responseSizeLimitMb: 50, historyRetentionDays: 0, saveHistoryResponses: false } })
    render(<SettingsMenu open onOpenChange={() => {}} />)

    const disable = await screen.findByRole('checkbox', { name: 'Desativar histórico' })
    await waitFor(() => expect(disable).toBeChecked())
    expect(screen.getByRole('spinbutton', { name: 'Retenção do histórico em dias' })).toBeDisabled()
  })

  it('não aceita retenção acima de 7 dias', async () => {
    render(<SettingsMenu open onOpenChange={() => {}} />)
    const days = await screen.findByRole('spinbutton', { name: 'Retenção do histórico em dias' })
    await waitFor(() => expect(days).toBeEnabled())

    fireEvent.change(days, { target: { value: '8' } })

    expect(screen.getByText(/Informe um número inteiro entre 1 e 7 dias/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Aplicar retenção do histórico' })).toBeDisabled()
  })

  it('não salva respostas no histórico por padrão e liga a opção na hora', async () => {
    saveGeneralSettings.mockResolvedValue({ ok: true, value: { requestTimeoutSeconds: 60, responseSizeLimitMb: 50, historyRetentionDays: 7, saveHistoryResponses: true } })
    render(<SettingsMenu open onOpenChange={() => {}} />)
    const toggle = await screen.findByRole('checkbox', { name: 'Salvar respostas no histórico' })
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).not.toBeChecked()

    fireEvent.click(toggle)

    await waitFor(() =>
      expect(saveGeneralSettings).toHaveBeenCalledWith({ requestTimeoutSeconds: 60, responseSizeLimitMb: 50, historyRetentionDays: 7, saveHistoryResponses: true }),
    )
    await waitFor(() => expect(toggle).toBeChecked())
  })

  it('mostra o erro quando o timeout salvo não pode ser carregado', async () => {
    getGeneralSettings.mockResolvedValue({ ok: false, error: { kind: 'storage', message: 'arquivo corrompido' } })
    render(<SettingsMenu open onOpenChange={() => {}} />)

    expect(await screen.findByText('Não foi possível carregar o timeout salvo: arquivo corrompido')).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Timeout em segundos' })).toBeDisabled()
  })
})

describe('SettingsMenu — atalhos', () => {
  const openShortcuts = (onOpenChange: (open: boolean) => void = () => {}) => {
    render(<SettingsMenu open onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Atalhos' }))
  }
  const capture = () => screen.getByRole('textbox', { name: 'Combinação de teclas' })
  const stored = () => JSON.parse(window.localStorage.getItem('alcy:shortcuts') ?? 'null')
  const captureClosed = (action: string) =>
    waitFor(() => expect(screen.queryByRole('dialog', { name: `Atalho de ${action}` })).not.toBeInTheDocument())

  it('lista as ações numa tabela com os atalhos padrão', () => {
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
      screen.getByRole('button', { name: 'Alterar atalho Delete de Remover item selecionado (collections e flows)' }),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Alterar atalho Ctrl+Tab de Próxima aba' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Alterar atalho Ctrl+Shift+Tab de Aba anterior' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Restaurar todos os padrões' })).toBeDisabled()
  })

  it('grava um botão do mouse no atalho do menu de blocos, e só nele', async () => {
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

  it('troca um atalho pela modal, adiciona um alternativo, remove e restaura o padrão', async () => {
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

  it('grava Enter quando nada foi pressionado ainda e confirma com o Enter seguinte', async () => {
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

  it('avisa do conflito com outra ação e move o atalho ao substituir', async () => {
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

  it('fecha só a modal de captura com Esc, sem gravar e sem fechar as configurações', async () => {
    const onOpenChange = vi.fn()
    openShortcuts(onOpenChange)
    fireEvent.click(screen.getByRole('button', { name: 'Alterar atalho Ctrl+Tab de Próxima aba' }))
    fireEvent.keyDown(capture(), { key: 'Escape' })
    await captureClosed('Próxima aba')

    // Com o foco fora do campo de captura, quem trata o Esc é a pilha de modais.
    fireEvent.click(screen.getByRole('button', { name: 'Alterar atalho Ctrl+Tab de Próxima aba' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancelar' }), { key: 'Escape' })
    await captureClosed('Próxima aba')

    expect(screen.getByRole('dialog', { name: 'Configurações' })).toBeVisible()
    expect(document.querySelector('.ui-modal-backdrop--closing')).toBeNull()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(stored()).toBeNull()
  })

  it('recusa combinações reservadas, sem modificador ou repetidas na mesma ação', () => {
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
