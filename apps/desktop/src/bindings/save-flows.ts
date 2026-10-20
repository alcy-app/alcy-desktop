import { invoke } from '@tauri-apps/api/core'
import type { FlowDto, FlowFolderDto, FlowsError } from './list-flows'

export interface SaveFlowsInput {
  flows: FlowDto[]
  folders: FlowFolderDto[]
}

export type SaveFlowsResult = { ok: true } | { ok: false; error: FlowsError }

export async function saveFlows(rootPath: string, input: SaveFlowsInput): Promise<SaveFlowsResult> {
  try {
    await invoke('save_flows', { input: { rootPath, ...input } })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error as FlowsError }
  }
}
