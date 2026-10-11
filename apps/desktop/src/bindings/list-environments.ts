import { invoke } from '@tauri-apps/api/core'

export interface EnvironmentVariableDto {
  name: string
  value: string
  sensitive: boolean
}

export interface EnvironmentDto {
  id: string
  name: string
  variables: EnvironmentVariableDto[]
}

export interface EnvironmentsSnapshotDto {
  environments: EnvironmentDto[]
  activeEnvironmentId: string | null
  /** Variáveis sensíveis cujo valor cifrado não pôde ser lido nesta máquina (vêm vazias), como "Ambiente › variável". */
  unreadableSecrets: string[]
}

export type EnvironmentsError = { kind: 'invalid'; message: string } | { kind: 'storage'; message: string }

export type ListEnvironmentsResult =
  | { ok: true; value: EnvironmentsSnapshotDto }
  | { ok: false; error: EnvironmentsError }

export async function listEnvironments(rootPath: string): Promise<ListEnvironmentsResult> {
  try {
    const value = await invoke<EnvironmentsSnapshotDto>('list_environments', { input: { rootPath } })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as EnvironmentsError }
  }
}
