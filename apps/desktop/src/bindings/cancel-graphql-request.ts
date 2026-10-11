import { invoke } from '@tauri-apps/api/core'

export function cancelGraphqlRequest(executionId: string): Promise<void> {
  return invoke('cancel_graphql_request', { input: { executionId } })
}
