import { invokeResult, type CommandResult } from './invoke-result'
import type { TabSessionError } from './load-tab-session'

export interface TabSessionEnvelope {
  version: 1
  activeTabId: string | null
  tabs: unknown[]
}

/** Grava a sessão de abas do workspace, substituindo a anterior. Acima de 16 MB é recusada. */
export function saveTabSession(rootPath: string, session: TabSessionEnvelope): Promise<CommandResult<null, TabSessionError>> {
  return invokeResult('save_tab_session', { input: { rootPath, session } })
}
