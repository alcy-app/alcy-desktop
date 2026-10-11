import { invoke } from '@tauri-apps/api/core'
import type { WorkspaceCommandError } from './create-workspace'

export interface RecentWorkspaceDto {
  rootPath: string
  name: string
  /** Se o workspace está vinculado a um repositório remoto (tem `alcy-git-link.json`). */
  linked: boolean
}

export type ListRecentWorkspacesResult =
  | { ok: true; value: RecentWorkspaceDto[] }
  | { ok: false; error: WorkspaceCommandError }

export async function listRecentWorkspaces(): Promise<ListRecentWorkspacesResult> {
  try {
    const value = await invoke<RecentWorkspaceDto[]>('list_recent_workspaces')
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as WorkspaceCommandError }
  }
}
