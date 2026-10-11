import { invoke } from '@tauri-apps/api/core'

export function cancelCollectionRun(runId: string): Promise<void> {
  return invoke('cancel_collection_run', { input: { runId } })
}
