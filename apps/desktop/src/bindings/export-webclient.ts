import { invokeResult, type CommandResult } from './invoke-result'
import type { CollectionDto } from './list-collections'
import type { EnvironmentVariableDto } from './list-environments'

/** O que exportar: a coleção inteira e, opcionalmente, a pasta dentro dela
 * (`src-tauri/src/commands/export_webclient.rs`). */
export interface WebclientSelectionInput {
  collection: CollectionDto
  folderId: string | null
  environment: { name: string; variables: EnvironmentVariableDto[] } | null
}

export type WebclientTransportMode = 'auto' | 'direct' | 'server'

export type WebclientCredentialTarget =
  | { kind: 'variable'; name: string }
  | { kind: 'authentication'; nodeId: string; field: 'token' | 'password' | 'value' | 'clientSecret' }
  | { kind: 'header'; nodeId: string; name: string }
  | { kind: 'query'; nodeId: string; name: string }
  | { kind: 'routeParameter'; nodeId: string; name: string }
  | { kind: 'bodyField'; nodeId: string; name: string }
  | { kind: 'bodyText'; nodeId: string; source: 'body' | 'variables' | 'query'; key: string }

export interface WebclientCredential {
  id: string
  owner: string | null
  target: WebclientCredentialTarget
  included: boolean
}

export type WebclientUnsupportedFeature = 'binaryBody' | 'formDataFile' | 'digestAuthentication' | 'grpc' | 'webSocket'

export interface WebclientSummary {
  requestCount: number
  folderCount: number
  credentials: WebclientCredential[]
  unsupported: { requestId: string; requestName: string; feature: WebclientUnsupportedFeature }[]
  hosts: string[]
  hasUnresolvedHosts: boolean
}

export type ExportWebclientError =
  | { kind: 'invalid'; message: string }
  | { kind: 'folderNotFound' }
  | { kind: 'noRequests' }
  | { kind: 'sensitiveNotConfirmed' }
  | { kind: 'passwordTooShort'; minimum: number }
  | { kind: 'storage'; message: string }

export interface ExportWebclientInput extends WebclientSelectionInput {
  path: string
  title: string
  transport: WebclientTransportMode
  includeSensitive: boolean
  sensitiveConfirmed: boolean
  password: string | null
}

export function previewWebclientExport(
  selection: WebclientSelectionInput,
  includeSensitive: boolean,
): Promise<CommandResult<WebclientSummary, ExportWebclientError>> {
  return invokeResult('preview_webclient_export', { input: { ...selection, includeSensitive } })
}

export function exportWebclient(input: ExportWebclientInput): Promise<CommandResult<null, ExportWebclientError>> {
  return invokeResult('export_webclient', { input })
}
