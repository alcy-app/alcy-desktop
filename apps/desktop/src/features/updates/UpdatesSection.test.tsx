import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '../../test-utils'
import type { DownloadProgressDto, ReleaseDto, UpdateSettingsDto, UpdateSourceDto } from '../../bindings/update-types'
import { UpdateStatusIndicator } from './UpdateStatusIndicator'
import { UpdatesSection } from './UpdatesSection'
import { STARTUP_CHECK_DELAY_MS } from './UpdateProvider'

const getUpdateSettings = vi.fn()
const setUpdateCheckOnStartup = vi.fn()
const checkForUpdate = vi.fn()
const downloadUpdate = vi.fn()
const cancelUpdateOperation = vi.fn()
const installUpdateAndRestart = vi.fn()
const openExternalUrl = vi.fn()
const flags = vi.hoisted(() => ({ updates: true }))

vi.mock('../../shared/feature-flags', () => ({ FEATURE_FLAGS: flags }))

vi.mock('../../bindings/get-update-settings', () => ({
  getUpdateSettings: (...args: unknown[]) => getUpdateSettings(...args),
}))
vi.mock('../../bindings/set-update-check-on-startup', () => ({
  setUpdateCheckOnStartup: (...args: unknown[]) => setUpdateCheckOnStartup(...args),
}))
vi.mock('../../bindings/check-for-update', () => ({
  checkForUpdate: (...args: unknown[]) => checkForUpdate(...args),
}))
vi.mock('../../bindings/download-update', () => ({
  downloadUpdate: (...args: unknown[]) => downloadUpdate(...args),
}))
vi.mock('../../bindings/cancel-update-operation', () => ({
  cancelUpdateOperation: (...args: unknown[]) => cancelUpdateOperation(...args),
}))
vi.mock('../../bindings/install-update-and-restart', () => ({
  installUpdateAndRestart: (...args: unknown[]) => installUpdateAndRestart(...args),
}))
vi.mock('../../bindings/open-external-url', () => ({
  openExternalUrl: (...args: unknown[]) => openExternalUrl(...args),
}))

const SOURCE: UpdateSourceDto = {
  provider: 'gitlab',
  location: 'https://gitlab.corp/grupo/alcy',
  host: 'gitlab.corp',
  requiresAccount: true,
  accountId: 'u@gitlab.corp',
}

function settings(overrides: Partial<UpdateSettingsDto> = {}): UpdateSettingsDto {
  return { currentVersion: '0.1.0', checkOnStartup: false, source: SOURCE, ...overrides }
}

const RELEASE: ReleaseDto = {
  version: '0.2.0',
  name: 'Alcy 0.2.0',
  notes: '- Atualizações pelo app',
  publishedAt: '2026-09-01T12:00:00Z',
  webUrl: 'https://gitlab.corp/grupo/alcy/-/releases/v0.2.0',
  installable: true,
}

const MB = 1024 * 1024

beforeEach(() => {
  for (const mock of [
    getUpdateSettings,
    setUpdateCheckOnStartup,
    checkForUpdate,
    downloadUpdate,
    cancelUpdateOperation,
    installUpdateAndRestart,
    openExternalUrl,
  ]) {
    mock.mockReset()
  }
  flags.updates = true
  getUpdateSettings.mockResolvedValue({ ok: true, value: settings() })
  openExternalUrl.mockResolvedValue({ ok: true })
})

afterEach(() => {
  vi.useRealTimers()
})

const renderSection = (onOpenGitlab = vi.fn()) =>
  render(
    <>
      <UpdatesSection onOpenGitlab={onOpenGitlab} />
      <UpdateStatusIndicator onOpen={() => {}} />
    </>,
  )

describe('UpdatesSection — origem', () => {
  it('sem origem no build, explica e não permite verificar', async () => {
    getUpdateSettings.mockResolvedValue({ ok: true, value: settings({ source: null }) })
    renderSection()

    expect(await screen.findByText('Este build não tem origem de atualizações configurada.')).toBeInTheDocument()
    expect(screen.getByText(/Nenhuma origem definida neste build/)).toBeInTheDocument()
    expect(screen.getByText('Alcy 0.1.0')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verificar atualizações' })).toBeDisabled()
  })

  it('mostra a origem do build e a conta GitLab usada, sem permitir editar', async () => {
    renderSection()

    expect(await screen.findByText('https://gitlab.corp/grupo/alcy')).toBeInTheDocument()
    expect(screen.getByText('GitLab')).toBeInTheDocument()
    expect(screen.getByText('Acessado pela conta u@gitlab.corp')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verificar atualizações' })).toBeEnabled()
  })

  it('sem conta GitLab na instância, oferece abrir as contas e não permite verificar', async () => {
    getUpdateSettings.mockResolvedValue({ ok: true, value: settings({ source: { ...SOURCE, accountId: null } }) })
    const onOpenGitlab = vi.fn()
    renderSection(onOpenGitlab)

    expect(await screen.findByText('Conecte uma conta GitLab de gitlab.corp para verificar atualizações.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Nenhuma conta GitLab conectada para gitlab.corp')
    expect(screen.getByRole('button', { name: 'Verificar atualizações' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Abrir contas GitLab' }))
    expect(onOpenGitlab).toHaveBeenCalledTimes(1)
  })

  it('origens públicas (GitHub) não pedem conta', async () => {
    getUpdateSettings.mockResolvedValue({
      ok: true,
      value: settings({
        source: { provider: 'github', location: 'empresa/alcy', host: 'github.com', requiresAccount: false, accountId: null },
      }),
    })
    renderSection()

    expect(await screen.findByText('empresa/alcy')).toBeInTheDocument()
    expect(screen.getByText('GitHub')).toBeInTheDocument()
    expect(screen.queryByText(/Acessado pela conta/)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verificar atualizações' })).toBeEnabled()
  })

  it('o servidor de releases não pede conta', async () => {
    getUpdateSettings.mockResolvedValue({
      ok: true,
      value: settings({
        source: {
          provider: 'releaseServer',
          location: 'http://alcy-releases.interno:32761',
          host: 'alcy-releases.interno',
          requiresAccount: false,
          accountId: null,
        },
      }),
    })
    renderSection()

    expect(await screen.findByText('http://alcy-releases.interno:32761')).toBeInTheDocument()
    expect(screen.getByText('Servidor de releases')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verificar atualizações' })).toBeEnabled()
  })
})

describe('UpdatesSection — verificar, baixar e reiniciar', () => {
  it('informa quando a versão instalada é a mais recente', async () => {
    checkForUpdate.mockResolvedValue({ ok: true, value: { currentVersion: '0.1.0', release: null } })
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Verificar atualizações' }))

    expect(await screen.findByText(/Você está usando a versão mais recente · verificado às/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verificar novamente' })).toBeEnabled()
  })

  it('falha de rede na verificação pede para conferir a conexão', async () => {
    checkForUpdate.mockResolvedValue({ ok: false, error: { kind: 'network', message: 'error sending request' } })
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Verificar atualizações' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Verifique a conexão de rede (e a VPN, se o servidor de atualizações exigir).')
    expect(screen.getByRole('alert')).not.toHaveTextContent('error sending request')
  })

  it('mostra o erro da verificação', async () => {
    checkForUpdate.mockResolvedValue({ ok: false, error: { kind: 'noManifest', tag: 'v0.2.0' } })
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Verificar atualizações' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('A release v0.2.0 não tem o manifesto latest.json anexado')
  })

  it('baixa com progresso, e reinicia após confirmação', async () => {
    checkForUpdate.mockResolvedValue({ ok: true, value: { currentVersion: '0.1.0', release: RELEASE } })
    let reportProgress: (progress: DownloadProgressDto) => void = () => {}
    let finishDownload: (value: unknown) => void = () => {}
    downloadUpdate.mockImplementation((_operationId: string, onProgress: (progress: DownloadProgressDto) => void) => {
      reportProgress = onProgress
      return new Promise((resolve) => {
        finishDownload = resolve
      })
    })
    installUpdateAndRestart.mockResolvedValue({ ok: false, error: { kind: 'updater', message: 'instalador falhou' } })
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Verificar atualizações' }))
    expect(await screen.findByText('Versão 0.2.0 disponível')).toBeInTheDocument()
    expect(screen.getByText('- Atualizações pelo app')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Versão 0.2.0 disponível. Abrir atualizações' })).toHaveTextContent('0.2.0')

    fireEvent.click(screen.getByRole('button', { name: 'Baixar atualização' }))
    act(() => reportProgress({ downloaded: 1 * MB, total: 2 * MB }))

    expect(await screen.findByText('1,0 MB de 2,0 MB')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
    expect(screen.getByRole('button', { name: 'Baixando a versão 0.2.0. Abrir atualizações' })).toHaveTextContent('50%')

    await act(async () => finishDownload({ ok: true, value: RELEASE }))
    expect(await screen.findByText('Versão 0.2.0 pronta para instalar')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Reiniciar e atualizar' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reiniciar para instalar a versão 0.2.0?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reiniciar agora' }))

    await waitFor(() => expect(installUpdateAndRestart).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Falha na atualização: instalador falhou')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reiniciar e atualizar' })).toBeEnabled()
  })

  it('cancela o download e volta a oferecer a versão sem mostrar erro', async () => {
    checkForUpdate.mockResolvedValue({ ok: true, value: { currentVersion: '0.1.0', release: RELEASE } })
    let finishDownload: (value: unknown) => void = () => {}
    downloadUpdate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDownload = resolve
        }),
    )
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Verificar atualizações' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Baixar atualização' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }))

    expect(cancelUpdateOperation).toHaveBeenCalledWith(downloadUpdate.mock.calls[0][0])
    await act(async () => finishDownload({ ok: false, error: { kind: 'cancelled' } }))

    expect(await screen.findByRole('button', { name: 'Baixar atualização' })).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('quando a instalação não se atualiza sozinha, leva à página da release', async () => {
    checkForUpdate.mockResolvedValue({ ok: true, value: { currentVersion: '0.1.0', release: { ...RELEASE, installable: false } } })
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: 'Verificar atualizações' }))

    expect(await screen.findByText(/Esta instalação não se atualiza sozinha/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Baixar atualização' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ver página da release' }))
    expect(openExternalUrl).toHaveBeenCalledWith(RELEASE.webUrl)
  })
})

describe('UpdatesSection — verificação automática', () => {
  it('verifica ao abrir quando a preferência está ligada', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    getUpdateSettings.mockResolvedValue({ ok: true, value: settings({ checkOnStartup: true }) })
    checkForUpdate.mockResolvedValue({ ok: true, value: { currentVersion: '0.1.0', release: RELEASE } })
    renderSection()

    await screen.findByText('Acessado pela conta u@gitlab.corp')
    expect(checkForUpdate).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS)
    })

    expect(checkForUpdate).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Versão 0.2.0 disponível')).toBeInTheDocument()
  })

  it('não verifica ao abrir com a preferência desligada', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderSection()

    await screen.findByText('Acessado pela conta u@gitlab.corp')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS * 2)
    })

    expect(checkForUpdate).not.toHaveBeenCalled()
  })

  it('com a feature flag desligada, não lê as preferências nem verifica ao abrir', async () => {
    flags.updates = false
    vi.useFakeTimers({ shouldAdvanceTime: true })
    getUpdateSettings.mockResolvedValue({ ok: true, value: settings({ checkOnStartup: true }) })
    checkForUpdate.mockResolvedValue({ ok: true, value: { currentVersion: '0.1.0', release: RELEASE } })
    render(<UpdateStatusIndicator onOpen={() => {}} />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS * 2)
    })

    expect(getUpdateSettings).not.toHaveBeenCalled()
    expect(checkForUpdate).not.toHaveBeenCalled()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('salva a preferência ao marcar ou desmarcar', async () => {
    setUpdateCheckOnStartup.mockResolvedValue({ ok: true, value: settings({ checkOnStartup: true }) })
    renderSection()

    const checkbox = await screen.findByRole('checkbox', { name: 'Verificar atualizações ao abrir o Alcy' })
    await waitFor(() => expect(checkbox).toBeEnabled())
    expect(checkbox).not.toBeChecked()

    fireEvent.click(checkbox)

    await waitFor(() => expect(setUpdateCheckOnStartup).toHaveBeenCalledWith(true))
    expect(await screen.findByRole('checkbox', { name: 'Verificar atualizações ao abrir o Alcy' })).toBeChecked()
  })
})
