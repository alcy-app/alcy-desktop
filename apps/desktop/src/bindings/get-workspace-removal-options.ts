import { invoke } from '@tauri-apps/api/core'
import type { WorkspaceCommandError } from './create-workspace'

export interface WorkspaceRemovalOptionsInput {
  rootPath: string
}

export interface WorkspaceRemovalOptionsDto {
  canDeleteFiles: boolean
  /** Who can delete them, when this person cannot. */
  ownerName: string | null
}

export type WorkspaceRemovalOptionsResult =
  | { ok: true; value: WorkspaceRemovalOptionsDto }
  | { ok: false; error: WorkspaceCommandError }

export async function getWorkspaceRemovalOptions(
  input: WorkspaceRemovalOptionsInput,
): Promise<WorkspaceRemovalOptionsResult> {
  try {
    const value = await invoke<WorkspaceRemovalOptionsDto>('get_workspace_removal_options', { input })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as WorkspaceCommandError }
  }
}
