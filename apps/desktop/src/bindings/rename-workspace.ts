import { invoke } from '@tauri-apps/api/core'
import type { WorkspaceCommandError, WorkspaceDto } from './create-workspace'

export interface RenameWorkspaceInput {
  rootPath: string
  name: string
}

export type RenameWorkspaceResult = { ok: true; value: WorkspaceDto } | { ok: false; error: WorkspaceCommandError }

export async function renameWorkspace(input: RenameWorkspaceInput): Promise<RenameWorkspaceResult> {
  try {
    const value = await invoke<WorkspaceDto>('rename_workspace', { input })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as WorkspaceCommandError }
  }
}
