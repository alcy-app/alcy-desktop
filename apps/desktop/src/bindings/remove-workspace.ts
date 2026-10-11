import { invoke } from '@tauri-apps/api/core'
import type { WorkspaceCommandError } from './create-workspace'
import type { RecentWorkspaceDto } from './list-recent-workspaces'

export interface RemoveWorkspaceInput {
  rootPath: string
  deleteFiles: boolean
}

export type RemoveWorkspaceResult =
  | { ok: true; value: RecentWorkspaceDto[] }
  | { ok: false; error: WorkspaceCommandError }

export async function removeWorkspace(input: RemoveWorkspaceInput): Promise<RemoveWorkspaceResult> {
  try {
    const value = await invoke<RecentWorkspaceDto[]>('remove_workspace', { input })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as WorkspaceCommandError }
  }
}
