import { invoke } from '@tauri-apps/api/core'
import type { EnvironmentDto, EnvironmentsError } from './list-environments'

export interface SaveEnvironmentsInput {
  environments: EnvironmentDto[]
  activeEnvironmentId: string | null
}

export type SaveEnvironmentsResult = { ok: true } | { ok: false; error: EnvironmentsError }

export async function saveEnvironments(
  rootPath: string,
  input: SaveEnvironmentsInput,
): Promise<SaveEnvironmentsResult> {
  try {
    await invoke('save_environments', { input: { rootPath, ...input } })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error as EnvironmentsError }
  }
}
