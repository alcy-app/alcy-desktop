import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { notifySecuritySettingsChanged, useSyncSensitiveValues } from './sensitive-sync'

const getSecuritySettings = vi.fn()
vi.mock('../../bindings/get-security-settings', () => ({ getSecuritySettings: () => getSecuritySettings() }))

function Probe() {
  return <span>{String(useSyncSensitiveValues())}</span>
}

describe('useSyncSensitiveValues', () => {
  beforeEach(() => {
    getSecuritySettings.mockReset()
  })

  it('reads the saved setting and follows every later save', async () => {
    getSecuritySettings.mockResolvedValue({ ok: true, value: { syncSensitiveValues: true } })
    render(<Probe />)
    expect(await screen.findByText('true')).toBeInTheDocument()

    act(() => notifySecuritySettingsChanged({ syncSensitiveValues: false, allowBodyFilesOutsideWorkspace: false }))
    expect(screen.getByText('false')).toBeInTheDocument()
  })

  it('keeps a save that lands before the first read answers', async () => {
    let answer: (value: unknown) => void = () => {}
    getSecuritySettings.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    render(<Probe />)

    act(() => notifySecuritySettingsChanged({ syncSensitiveValues: true, allowBodyFilesOutsideWorkspace: false }))
    await act(async () => answer({ ok: true, value: { syncSensitiveValues: false } }))

    expect(screen.getByText('true')).toBeInTheDocument()
  })

  it('assumes the protection is on when the setting cannot be read', async () => {
    getSecuritySettings.mockResolvedValue({ ok: false, error: { kind: 'storage', message: 'x' } })
    render(<Probe />)
    await act(async () => {})
    expect(screen.getByText('false')).toBeInTheDocument()
  })
})
