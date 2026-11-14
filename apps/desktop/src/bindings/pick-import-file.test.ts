import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { pickImportFiles, pickImportFolder } from './pick-import-file'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const pickInput = () => (vi.mocked(invoke).mock.calls[0][1] as { input: { directory: boolean; multiple: boolean; filters: Array<{ extensions: string[] }> } }).input

describe('pickImportFiles', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it('opens the backend dialog with multiple selection', async () => {
    vi.mocked(invoke).mockResolvedValue(['/import/collection.json', '/import/environment.json'])

    await expect(pickImportFiles()).resolves.toEqual(['/import/collection.json', '/import/environment.json'])
    expect(invoke).toHaveBeenCalledWith('pick_paths', { input: expect.objectContaining({ directory: false, multiple: true }) })
  })

  it('accepts HAR files in the dialog filter', async () => {
    vi.mocked(invoke).mockResolvedValue([])

    await pickImportFiles()

    expect(pickInput().filters[0].extensions).toContain('har')
  })

  it('returns an empty list when cancelled or when the command fails', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('boom'))

    await expect(pickImportFiles()).resolves.toEqual([])
    await expect(pickImportFiles()).resolves.toEqual([])
  })

  it('picks a single folder', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(['/import/collections']).mockResolvedValueOnce([])

    await expect(pickImportFolder()).resolves.toBe('/import/collections')
    expect(pickInput()).toEqual({ directory: true, multiple: false, filters: [] })
    await expect(pickImportFolder()).resolves.toBeNull()
  })
})
