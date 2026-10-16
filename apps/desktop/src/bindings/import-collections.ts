import { invoke } from '@tauri-apps/api/core'
import type { EnvironmentDto, EnvironmentVariableDto } from './list-environments'
import type { CollectionDto, CollectionsError } from './list-collections'

export interface ImportWarningDto {
  requestPath: string
  phase: 'preRequest' | 'postResponse' | 'request' | 'body' | string
  line: number | null
  api: string
  reason: 'unsupported' | 'partialSemantics' | 'skippedProtocol' | 'unsupportedMethod' | 'invalidEntry' | 'skippedFile' | string
}

/** Variables to upsert, by name, into an environment the workspace already has (spec 0130). */
export interface EnvironmentMergeDto {
  environmentId: string
  variables: EnvironmentVariableDto[]
}

export interface ImportedCollectionDataDto {
  collections: CollectionDto[]
  environments: EnvironmentDto[]
  environmentMerges?: EnvironmentMergeDto[]
  scriptCount: number
  warnings: ImportWarningDto[]
}

export type ImportCollectionsResult =
  | { ok: true; value: ImportedCollectionDataDto }
  | { ok: false; error: CollectionsError }

/** `rootPath`: workspace que recebe a documentação importada (ADR 0035). */
export async function importCollections(path: string, rootPath: string): Promise<ImportCollectionsResult> {
  try {
    const value = await invoke<ImportedCollectionDataDto>('import_collections', { input: { path, rootPath } })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as CollectionsError }
  }
}
