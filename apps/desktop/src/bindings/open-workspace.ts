import { invoke } from '@tauri-apps/api/core'
import type { WorkspaceCommandError, WorkspaceDto } from './create-workspace'

export interface OpenWorkspaceInput {
  rootPath: string
}

export type OpenWorkspaceResult = { ok: true; value: WorkspaceDto } | { ok: false; error: WorkspaceCommandError }

export async function openWorkspace(input: OpenWorkspaceInput): Promise<OpenWorkspaceResult> {
  try {
    const value = await invoke<WorkspaceDto>('open_workspace', { input })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as WorkspaceCommandError }
  }
}
