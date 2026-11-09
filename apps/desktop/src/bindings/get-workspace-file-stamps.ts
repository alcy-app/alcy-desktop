import { invoke } from '@tauri-apps/api/core'
import type { WorkspaceCommandError } from './create-workspace'

export interface WorkspaceFileStampDto {
  name: string
  stamp: string
}

export type WorkspaceFileStampsResult =
  | { ok: true; value: WorkspaceFileStampDto[] }
  | { ok: false; error: WorkspaceCommandError }

export async function getWorkspaceFileStamps(rootPath: string): Promise<WorkspaceFileStampsResult> {
  try {
    const value = await invoke<WorkspaceFileStampDto[]>('get_workspace_file_stamps', { input: { rootPath } })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as WorkspaceCommandError }
  }
}
