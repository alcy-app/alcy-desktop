import { invoke } from '@tauri-apps/api/core'

export function releaseResponseBody(handle: string): Promise<void> {
  return invoke('release_response_body', { input: { handle } })
}
