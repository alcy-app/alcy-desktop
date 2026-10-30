import { invokeResult, type CommandResult } from './invoke-result'
import type { TabSessionError } from './load-tab-session'

export interface TabSessionEnvelope {
  version: 1
  activeTabId: string | null
  groups?: unknown[]
  tabs: unknown[]
}

/** Replace the workspace tab session; snapshots larger than 16 MB are rejected. */
export function saveTabSession(rootPath: string, session: TabSessionEnvelope): Promise<CommandResult<null, TabSessionError>> {
  return invokeResult('save_tab_session', { input: { rootPath, session } })
}
