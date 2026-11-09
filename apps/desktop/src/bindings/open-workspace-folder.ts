import { invoke } from '@tauri-apps/api/core'
import type { WorkspaceCommandError } from './create-workspace'

export type OpenWorkspaceFolderResult = { ok: true } | { ok: false; error: WorkspaceCommandError }

export async function openWorkspaceFolder(input: { rootPath: string }): Promise<OpenWorkspaceFolderResult> {
  try {
    await invoke('open_workspace_folder', { input })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error as WorkspaceCommandError }
  }
}
