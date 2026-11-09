import { invoke } from '@tauri-apps/api/core'

export interface WorkspaceDto {
  id: string
  name: string
  rootPath: string
}

export type WorkspaceCommandError =
  | { kind: 'invalid'; message: string }
  | { kind: 'notAWorkspace'; message: string }
  | { kind: 'notOwner'; message: string }
  | { kind: 'invalidFolderName'; message: string }
  | { kind: 'folderExists'; message: string }
  | { kind: 'folderInUse'; message: string }
  | { kind: 'workspaceBusy'; message: string }
  | { kind: 'storage'; message: string }

export interface CreateWorkspaceInput {
  id: string
}

export type CreateWorkspaceResult = { ok: true; value: WorkspaceDto } | { ok: false; error: WorkspaceCommandError }

export async function createWorkspace(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult> {
  try {
    const value = await invoke<WorkspaceDto>('create_workspace', { input })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as WorkspaceCommandError }
  }
}
