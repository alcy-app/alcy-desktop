import { invokeResult, type CommandResult } from './invoke-result'

export interface SecuritySettingsDto {
  /** Versiona os valores de variáveis sensíveis (em texto claro). */
  syncSensitiveValues: boolean
}

export type SecuritySettingsCommandError = { kind: 'storage'; message: string }

export function getSecuritySettings(): Promise<CommandResult<SecuritySettingsDto, SecuritySettingsCommandError>> {
  return invokeResult('get_security_settings')
}
