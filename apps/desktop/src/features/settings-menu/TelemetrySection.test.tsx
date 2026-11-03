import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../test-utils'
import { TelemetrySection } from './TelemetrySection'

const getUsageEventsStatus = vi.fn()
const setUsageEventsEnabled = vi.fn()
const listRecentUsageEvents = vi.fn()
const applyUsageEventsStatus = vi.fn()

vi.mock('../../bindings/usage-events', () => ({
  getUsageEventsStatus: (...args: unknown[]) => getUsageEventsStatus(...args),
  setUsageEventsEnabled: (...args: unknown[]) => setUsageEventsEnabled(...args),
  listRecentUsageEvents: (...args: unknown[]) => listRecentUsageEvents(...args),
}))
vi.mock('../../shared/usage-events/track-usage', () => ({
  applyUsageEventsStatus: (...args: unknown[]) => applyUsageEventsStatus(...args),
}))

const opened = {
  schema: 1,
  eventId: '0123456789abcdef0123456789abcdef',
  occurredOn: '2026-11-02',
  appVersion: '1.2.3',
  platform: 'windows',
  name: 'app_opened',
  props: { startupMs: 900 },
}

beforeEach(() => {
  getUsageEventsStatus.mockReset()
  setUsageEventsEnabled.mockReset()
  listRecentUsageEvents.mockReset()
  applyUsageEventsStatus.mockReset()
  listRecentUsageEvents.mockResolvedValue([opened])
})

describe('TelemetrySection', () => {
  it('says the build collects nothing when no extension collects usage events', async () => {
    getUsageEventsStatus.mockResolvedValue({ available: false, enabled: true })
    render(<TelemetrySection />)
    expect(await screen.findByText('Este build não coleta nem envia dados de uso.')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('is on by default, explains what is and is never recorded and shows this session’s events', async () => {
    getUsageEventsStatus.mockResolvedValue({ available: true, enabled: true })
    render(<TelemetrySection />)
    expect(await screen.findByRole('checkbox', { name: 'Enviar dados de uso anônimos' })).toBeChecked()
    expect(screen.getByText('O que é registrado')).toBeInTheDocument()
    expect(screen.getByText(/URLs, hosts, rotas, corpos, headers/)).toBeInTheDocument()
    const events = screen.getByRole('list', { name: 'Eventos registrados nesta sessão' })
    expect(events).toHaveTextContent('app_opened')
    expect(events).toHaveTextContent('"occurredOn":"2026-11-02"')
    expect(events).toHaveTextContent('"startupMs":900')
    expect(events).not.toHaveTextContent('0123456789abcdef')
  })

  it('turns telemetry off and tells the interface to stop reporting', async () => {
    getUsageEventsStatus.mockResolvedValue({ available: true, enabled: true })
    setUsageEventsEnabled.mockResolvedValue({ ok: true, value: { available: true, enabled: false } })
    render(<TelemetrySection />)
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Enviar dados de uso anônimos' }))

    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked())
    expect(setUsageEventsEnabled).toHaveBeenCalledWith(false)
    expect(applyUsageEventsStatus).toHaveBeenCalledWith({ available: true, enabled: false })
    expect(screen.getByText('A telemetria está desligada: nada está sendo registrado.')).toBeInTheDocument()
  })

  it('keeps the choice and shows an error when saving fails', async () => {
    getUsageEventsStatus.mockResolvedValue({ available: true, enabled: true })
    setUsageEventsEnabled.mockResolvedValue({ ok: false, error: { kind: 'storage', message: 'disk' } })
    render(<TelemetrySection />)
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Enviar dados de uso anônimos' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível salvar a preferência de telemetria.')
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(applyUsageEventsStatus).not.toHaveBeenCalled()
  })
})
