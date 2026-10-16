import { invoke } from '@tauri-apps/api/core'
import type { ImportedCollectionDataDto } from './import-collections'
import type { CollectionsError } from './list-collections'

export interface PreparedImportDto {
  id: string
  format: 'openapi' | 'postman' | 'insomnia' | 'bruno' | 'har' | 'alcy' | string
  title: string
  collectionCount: number
  folderCount: number
  requestCount: number
  environmentCount: number
  supportsDocumentation: boolean
  scriptCount: number
  warningCount: number
  /** Variables the review offers (spec 0130). */
  variables: ImportVariableCandidateDto[]
  /** Imported environment and collection names, by index. */
  environmentNames: string[]
  collectionNames: string[]
}

export type ImportVariableOriginDto =
  | { kind: 'environment'; index: number }
  | { kind: 'collection'; index: number }
  | { kind: 'referenced' }

export interface ImportVariableCandidateDto {
  key: string
  name: string
  value: string
  /** Long values arrive cut and stay read-only; the commit keeps the original. */
  valueTruncated: boolean
  sensitive: boolean
  origin: ImportVariableOriginDto
  included: boolean
}

export type ImportVariableTargetDto =
  | { kind: 'importedEnvironment'; index: number }
  | { kind: 'newEnvironment'; name: string }
  | { kind: 'existingEnvironment'; id: string }
  | { kind: 'collection'; index: number }

export interface ImportVariableSelectionDto {
  key: string
  include: boolean
  name: string
  /** `null` keeps the imported value. */
  value: string | null
  sensitive: boolean
  target: ImportVariableTargetDto
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
  variables?: ImportVariableSelectionDto[],
): Promise<CommitPreparedImportResult> {
  try {
    const value = await invoke<ImportedCollectionDataDto>('commit_prepared_import', {
      input: { id, rootPath, includeDocumentation, variables: variables ?? null },
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
