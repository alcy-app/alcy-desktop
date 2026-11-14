import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { pickFlowImportFile } from './import-flow'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

beforeEach(() => { vi.mocked(invoke).mockReset().mockResolvedValue(['/imports/example.json']) })

describe('shared flow file picker', () => {
  it('offers all supported formats together when load testing is enabled', async () => {
    await expect(pickFlowImportFile(true)).resolves.toBe('/imports/example.json')
    expect(invoke).toHaveBeenCalledWith('pick_paths', {
      input: { directory: false, multiple: false, filters: [{ name: 'Alcy / k6 / JMeter', extensions: ['json', 'js', 'ts', 'jmx', 'xml'] }] },
    })
  })

  it('only offers Alcy JSON when load testing is disabled', async () => {
    await pickFlowImportFile(false)
    expect(invoke).toHaveBeenCalledWith('pick_paths', {
      input: expect.objectContaining({ filters: [{ name: 'Alcy Flow', extensions: ['json'] }] }),
    })
  })

  it('returns null when the dialog is cancelled', async () => {
    vi.mocked(invoke).mockResolvedValue([])
    await expect(pickFlowImportFile(false)).resolves.toBeNull()
  })
})
