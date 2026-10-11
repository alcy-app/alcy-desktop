import { invoke } from '@tauri-apps/api/core'

export function cancelFlow(flowExecutionId: string): Promise<void> {
  return invoke('cancel_flow', { input: { flowExecutionId } })
}
