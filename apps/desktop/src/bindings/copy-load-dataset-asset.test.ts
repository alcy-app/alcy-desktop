import { describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { copyLoadDatasetAsset } from './copy-load-dataset-asset'

describe('copyLoadDatasetAsset', () => {
  it('envia somente o caminho escolhido, o workspace e o flow', async () => {
    invoke.mockResolvedValueOnce({ assetId: 'dataset-a.csv', rows: 2 })

    await expect(copyLoadDatasetAsset('/workspace', 'flow-a', '/outside/users.csv')).resolves.toEqual({
      ok: true,
      value: { assetId: 'dataset-a.csv', rows: 2 },
    })
    expect(invoke).toHaveBeenCalledWith('copy_load_dataset_asset', {
      input: { rootPath: '/workspace', flowId: 'flow-a', sourcePath: '/outside/users.csv' },
    })
  })

  it('preserva o erro estruturado do backend', async () => {
    invoke.mockRejectedValueOnce({ kind: 'invalid', message: 'CSV inválido' })

    await expect(copyLoadDatasetAsset('/workspace', 'flow-a', '/outside/users.csv')).resolves.toEqual({
      ok: false,
      error: { kind: 'invalid', message: 'CSV inválido' },
    })
  })
})
