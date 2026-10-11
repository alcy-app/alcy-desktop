import { invoke } from '@tauri-apps/api/core'
import type { ImportedCollectionDataDto } from './import-collections'
import type { CollectionsError } from './list-collections'

export interface PreparedImportDto {
  id: string
  format: 'openapi' | 'postman' | 'insomnia' | 'bruno' | 'alcy' | string
  title: string
  collectionCount: number
  folderCount: number
  requestCount: number
  environmentCount: number
  supportsDocumentation: boolean
  scriptCount: number
  warningCount: number
}

export type PrepareImportResult =
  | { ok: true; value: PreparedImportDto }
  | { ok: false; error: CollectionsError }

export type CommitPreparedImportResult =
  | { ok: true; value: ImportedCollectionDataDto }
  | { ok: false; error: CollectionsError }

async function prepare(command: string, input: Record<string, string>): Promise<PrepareImportResult> {
  try {
    const value = await invoke<PreparedImportDto>(command, { input })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as CollectionsError }
  }
}

export function prepareImportFromPath(path: string, rootPath: string): Promise<PrepareImportResult> {
  return prepare('prepare_import_from_path', { path, rootPath })
}

export function prepareImportFromUrl(url: string, rootPath: string): Promise<PrepareImportResult> {
  return prepare('prepare_import_from_url', { url, rootPath })
}

export function prepareImportFromText(content: string, rootPath: string): Promise<PrepareImportResult> {
  return prepare('prepare_import_from_text', { content, rootPath })
}

export async function commitPreparedImport(
  id: string,
  rootPath: string,
  includeDocumentation: boolean,
): Promise<CommitPreparedImportResult> {
  try {
    const value = await invoke<ImportedCollectionDataDto>('commit_prepared_import', {
      input: { id, rootPath, includeDocumentation },
    })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as CollectionsError }
  }
}

export async function discardPreparedImport(id: string): Promise<void> {
  try {
    await invoke('discard_prepared_import', { input: { id } })
  } catch {
    // A sessão é temporária e também expira pelo limite do backend.
  }
}
