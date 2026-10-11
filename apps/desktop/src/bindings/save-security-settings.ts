import type { SecuritySettingsCommandError, SecuritySettingsDto } from './get-security-settings'
import { invokeResult, type CommandResult } from './invoke-result'

export function saveSecuritySettings(
  input: SecuritySettingsDto,
): Promise<CommandResult<SecuritySettingsDto, SecuritySettingsCommandError>> {
  return invokeResult('save_security_settings', { input })
}
