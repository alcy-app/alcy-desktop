import { invokeResult, type CommandResult } from './invoke-result'

export type TabSessionError = { kind: 'storage'; message: string }

/** Sessão de abas gravada do workspace (ADR 0039), ou `null` se ainda não houver. O backend só
 * garante o envelope (`version`, `tabs`): quem lê valida cada aba. */
export function loadTabSession(rootPath: string): Promise<CommandResult<unknown, TabSessionError>> {
  return invokeResult('load_tab_session', { input: { rootPath } })
}
