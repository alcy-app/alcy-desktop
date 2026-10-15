import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pickImportFiles, pickImportFolder } from './pick-import-file'

const openDialog = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => openDialog(...args),
}))

describe('pickImportFiles', () => {
  beforeEach(() => {
    openDialog.mockReset()
  })

  it('habilita seleção múltipla no diálogo nativo', async () => {
    openDialog.mockResolvedValue(['/import/collection.json', '/import/environment.json'])

    await expect(pickImportFiles()).resolves.toEqual([
      '/import/collection.json',
      '/import/environment.json',
    ])
    expect(openDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: false,
        multiple: true,
      }),
    )
  })

  it('accepts HAR files in the native dialog filter', async () => {
    openDialog.mockResolvedValue(null)

    await pickImportFiles()

    const [{ filters }] = openDialog.mock.calls[0] as [{ filters: Array<{ extensions: string[] }> }]
    expect(filters[0].extensions).toContain('har')
  })

  it('normaliza cancelamento e o retorno singular do diálogo', async () => {
    openDialog.mockResolvedValueOnce(null).mockResolvedValueOnce('/import/collection.json')

    await expect(pickImportFiles()).resolves.toEqual([])
    await expect(pickImportFiles()).resolves.toEqual(['/import/collection.json'])
  })

  it('escolhe uma única pasta no diálogo nativo', async () => {
    openDialog.mockResolvedValueOnce('/import/collections').mockResolvedValueOnce(null)

    await expect(pickImportFolder()).resolves.toBe('/import/collections')
    expect(openDialog).toHaveBeenCalledWith({ directory: true, multiple: false })
    await expect(pickImportFolder()).resolves.toBeNull()
  })
})
