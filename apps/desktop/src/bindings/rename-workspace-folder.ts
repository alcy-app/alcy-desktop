import { invoke } from '@tauri-apps/api/core'
import type { WorkspaceCommandError, WorkspaceDto } from './create-workspace'

export interface RenameWorkspaceFolderInput {
  rootPath: string
  folderName: string
}

export type RenameWorkspaceFolderResult = { ok: true; value: WorkspaceDto } | { ok: false; error: WorkspaceCommandError }

export async function renameWorkspaceFolder(input: RenameWorkspaceFolderInput): Promise<RenameWorkspaceFolderResult> {
  try {
    const value = await invoke<WorkspaceDto>('rename_workspace_folder', { input })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as WorkspaceCommandError }
  }
}
