import { invoke } from '@tauri-apps/api/core'

export interface LoadDatasetAssetDto {
  assetId: string
  rows: number
}

export type CopyLoadDatasetAssetResult =
  | { ok: true; value: LoadDatasetAssetDto }
  | { ok: false; error: { kind: 'notFound' } | { kind: 'invalid' | 'storage'; message: string } }

export async function copyLoadDatasetAsset(rootPath: string, flowId: string, sourcePath: string): Promise<CopyLoadDatasetAssetResult> {
  try {
    const value = await invoke<LoadDatasetAssetDto>('copy_load_dataset_asset', { input: { rootPath, flowId, sourcePath } })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as CopyLoadDatasetAssetResult extends { ok: false; error: infer E } ? E : never }
  }
}
