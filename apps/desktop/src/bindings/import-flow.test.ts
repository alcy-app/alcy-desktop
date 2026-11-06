import { beforeEach, describe, expect, it, vi } from 'vitest'
import { open } from '@tauri-apps/plugin-dialog'
import { pickFlowImportFile } from './import-flow'

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

beforeEach(() => { vi.mocked(open).mockReset().mockResolvedValue('/imports/example.json') })

describe('shared flow file picker', () => {
  it('offers all supported formats together when load testing is enabled', async () => {
    await expect(pickFlowImportFile(true)).resolves.toBe('/imports/example.json')
    expect(open).toHaveBeenCalledWith({ directory: false, multiple: false, filters: [{ name: 'Alcy / k6 / JMeter', extensions: ['json', 'js', 'ts', 'jmx', 'xml'] }] })
  })

  it('only offers Alcy JSON when load testing is disabled', async () => {
    await pickFlowImportFile(false)
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ filters: [{ name: 'Alcy Flow', extensions: ['json'] }] }))
  })
})
