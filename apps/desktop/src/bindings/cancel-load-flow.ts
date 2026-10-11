import { invoke } from '@tauri-apps/api/core'

export function cancelLoadFlow(loadRunId: string): Promise<void> {
  return invoke('cancel_load_flow', { input: { loadRunId } })
}
