import { invokeResult, type CommandResult } from './invoke-result'

export interface CustomCaCertificateDto {
  id: string
  name: string
}

export type CustomCaCertificateCommandError =
  | { kind: 'file'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'storage'; message: string }

export function listCustomCaCertificates(): Promise<CommandResult<CustomCaCertificateDto[], CustomCaCertificateCommandError>> {
  return invokeResult('list_custom_ca_certificates')
}

export function addCustomCaCertificate(path: string): Promise<CommandResult<CustomCaCertificateDto[], CustomCaCertificateCommandError>> {
  return invokeResult('add_custom_ca_certificate', { path })
}

export function removeCustomCaCertificate(id: string): Promise<CommandResult<CustomCaCertificateDto[], CustomCaCertificateCommandError>> {
  return invokeResult('remove_custom_ca_certificate', { id })
}
