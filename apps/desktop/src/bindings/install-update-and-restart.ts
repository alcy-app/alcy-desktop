import { invokeResult, type CommandResult } from './invoke-result'
import type { UpdateCommandError } from './update-types'

/** Instala o pacote já baixado e reinicia o app (só retorna em caso de erro). */
export function installUpdateAndRestart(): Promise<CommandResult<void, UpdateCommandError>> {
  return invokeResult('install_update_and_restart')
}
