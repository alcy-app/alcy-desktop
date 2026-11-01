import { invoke } from '@tauri-apps/api/core'
import type { FlowDto } from './list-flows'

/** A problem a run of the flow would hit, with how to fix it (spec 0139). */
export interface FlowIssueDto {
  severity: 'error' | 'warning'
  nodeId?: string
  message: string
  fix: string
}

/** Static checks of a flow, without running it. `knownVariables` enables the unknown-variable warnings. */
export async function checkFlow(flow: FlowDto, knownVariables?: string[]): Promise<FlowIssueDto[]> {
  return invoke<FlowIssueDto[]>('check_flow', { input: { flow, knownVariables } })
}
