import { invokeResult, type CommandResult } from './invoke-result'

export interface TlsSettingsDto {
  /** Verifica o certificado do servidor nas chamadas do usuário. */
  verifyCertificates: boolean
}

export type TlsSettingsCommandError =
  | { kind: 'client'; message: string }
  | { kind: 'storage'; message: string }

export function getTlsSettings(): Promise<CommandResult<TlsSettingsDto, TlsSettingsCommandError>> {
  return invokeResult('get_tls_settings')
}

export function saveTlsSettings(input: TlsSettingsDto): Promise<CommandResult<TlsSettingsDto, TlsSettingsCommandError>> {
  return invokeResult('save_tls_settings', { input })
}
