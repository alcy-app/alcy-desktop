import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const flags = vi.hoisted(() => ({ usageEvents: true }))
const invoke = vi.hoisted(() => vi.fn())
vi.mock('../feature-flags', () => ({ FEATURE_FLAGS: flags }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

import { applyUsageEventsStatus, resetUsageEventsForTests, startUsageEvents, trackUsage } from './track-usage'

const recorded = () => invoke.mock.calls.filter(([command]) => command === 'record_usage_event').map(([, args]) => args)

beforeEach(() => {
  resetUsageEventsForTests()
  invoke.mockReset()
  flags.usageEvents = true
})

afterEach(() => resetUsageEventsForTests())

describe('trackUsage', () => {
  it('makes no call at all when the flag is off', async () => {
    flags.usageEvents = false
    await startUsageEvents()
    trackUsage({ name: 'environment_switched' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('stops reporting when no extension collects events', async () => {
    invoke.mockResolvedValueOnce({ available: false, enabled: true })
    trackUsage({ name: 'environment_switched' })
    await startUsageEvents()
    trackUsage({ name: 'sidebar_module_opened', module: 'flows' })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('activate_usage_events', { utcOffsetMinutes: -new Date().getTimezoneOffset() })
  })

  it('sends queued and later events once active', async () => {
    invoke.mockResolvedValue({ available: true, enabled: true })
    trackUsage({ name: 'environment_switched' })
    await startUsageEvents()
    trackUsage({ name: 'shortcut_changed', action: 'request.send', change: 'assigned' })
    expect(recorded()).toEqual([
      { event: { name: 'environment_switched' } },
      { event: { name: 'shortcut_changed', action: 'request.send', change: 'assigned' } },
    ])
  })

  it('treats a failed activation as off', async () => {
    invoke.mockRejectedValueOnce(new Error('no tauri'))
    await startUsageEvents()
    trackUsage({ name: 'environment_switched' })
    expect(recorded()).toEqual([])
  })

  it('activates only once', async () => {
    invoke.mockResolvedValue({ available: true, enabled: true })
    await startUsageEvents()
    await startUsageEvents()
    expect(invoke.mock.calls.filter(([command]) => command === 'activate_usage_events')).toHaveLength(1)
  })

  it('reports nothing while the person keeps telemetry off, and resumes when turned on', async () => {
    invoke.mockResolvedValue({ available: true, enabled: false })
    trackUsage({ name: 'environment_switched' })
    await startUsageEvents()
    trackUsage({ name: 'environment_switched' })
    expect(recorded()).toEqual([])

    applyUsageEventsStatus({ available: true, enabled: true })
    trackUsage({ name: 'sidebar_module_opened', module: 'flows' })
    expect(recorded()).toEqual([{ event: { name: 'sidebar_module_opened', module: 'flows' } }])

    applyUsageEventsStatus({ available: true, enabled: false })
    trackUsage({ name: 'environment_switched' })
    expect(recorded()).toHaveLength(1)
  })
})
