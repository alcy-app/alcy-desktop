import { invokeResult, type CommandResult } from './invoke-result'
import type { UpdateCommandError, UpdateSettingsDto } from './update-types'

export function setUpdateIncludePrereleases(enabled: boolean): Promise<CommandResult<UpdateSettingsDto, UpdateCommandError>> {
  return invokeResult('set_update_include_prereleases', { input: { enabled } })
}
