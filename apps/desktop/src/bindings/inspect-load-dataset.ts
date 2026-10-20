import { invoke } from '@tauri-apps/api/core'

export interface LoadDatasetFieldsDto {
  fields: { name: string; preview: string; reference: string | null }[]
  nextOffset: number | null
  rows: number
}

export function inspectLoadDataset(input: { rootPath: string; flowId: string; assetId: string; queryId: string; offset: number; query: string }): Promise<LoadDatasetFieldsDto> {
  return invoke('inspect_load_dataset', { input })
}
