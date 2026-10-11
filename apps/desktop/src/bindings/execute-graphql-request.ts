import { invoke } from '@tauri-apps/api/core'
import type { EnvironmentVariableDto } from './list-environments'
import type { ScopedVariableDto } from './list-collections'

export type AuthenticationInput =
  | { type: 'none' }
  | { type: 'inherit' }
  | { type: 'customHeader'; name: string; value: string }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'digest'; username: string; password: string }
  | { type: 'oauth2ClientCredentials'; clientId: string; clientSecret: string; tokenUrl: string; scope: string }

export interface HeaderInput {
  name: string
  value: string
  enabled: boolean
}

export interface ExecuteGraphqlRequestInput {
  executionId: string
  rootPath: string
  endpointUrl: string
  query: string
  variables: string
  headers: HeaderInput[]
  authentication: AuthenticationInput
  /** Requisição salva de origem; o backend usa para resolver `inherit`. */
  requestId?: string | null
  /** Aba que disparou o envio, para o histórico de envios da requisição. */
  tabId?: string | null
  /** Só o ambiente ativo; as variáveis de coleção/pasta vão em `variableScopes`. */
  environmentVariables: EnvironmentVariableDto[]
  variableScopes: VariableScopeInput[]
  preRequestScript: string
  postResponseScript: string
  /** "Reenviar sem limite": ignora o limite de tamanho de resposta só neste envio. */
  ignoreResponseSizeLimit?: boolean
}

/** Uma camada de variáveis de coleção/pasta da requisição, da coleção raiz até a pasta pai direta (ADR 0031). */
export interface VariableScopeInput {
  nodeId: string
  kind: 'collection' | 'folder'
  variables: ScopedVariableDto[]
}

/** Variável de ambiente gravada por um script (`al.environment.set`). */
export interface EnvironmentChange {
  name: string
  value: string | null
}

/** Variável de coleção/pasta gravada por um script (`al.collection.set`/`al.folder.set`). */
export interface ScopedVariableChange {
  nodeId: string
  name: string
  value: string | null
}

/** Resultado de um `al.test` registrado por um script (spec 0072). */
export interface ScriptTestResult {
  name: string
  passed: boolean
  message: string | null
}

/** Efeitos que os scripts já produziram quando a execução falhou (ex.: o
 * pré-script rodou, mas o envio falhou por rede). O backend envia esses
 * campos junto do erro; ausentes quando nenhum script chegou a rodar. */
export interface ScriptEffectsOnFailure {
  environmentChanges?: EnvironmentChange[]
  scopedChanges?: ScopedVariableChange[]
  scriptLogs?: string[]
  testResults?: ScriptTestResult[]
}

/** Separa do payload de erro do comando os efeitos dos scripts. */
export function splitExecutionFailure<E>(payload: unknown): { error: E } & ScriptEffectsOnFailure {
  if (typeof payload !== 'object' || payload === null) return { error: payload as E }
  const { environmentChanges, scopedChanges, scriptLogs, testResults, ...error } = payload as E & ScriptEffectsOnFailure
  return { error: error as E, environmentChanges, scopedChanges, scriptLogs, testResults }
}

/** Falha do script de pós-resposta; a resposta continua válida. */
export interface ScriptErrorOutput {
  phase: 'preRequest' | 'postResponse'
  message: string
}

export interface ResponseHeader {
  name: string
  value: string
}

export interface Cookie {
  name: string
  value: string
  domain: string | null
  path: string | null
  expires: string | null
  maxAgeSeconds: number | null
  secure: boolean
  httpOnly: boolean
  sameSite: string | null
}

export interface ConnectionInfo {
  remoteAddress: string | null
  httpVersion: string
  tlsCertificatePresent: boolean
  /** Conexão TLS feita com a verificação de certificado desligada (ADR 0058). */
  certificateVerificationDisabled: boolean
}

export interface GraphqlErrorLocation {
  line: number
  column: number
}

export interface GraphqlErrorOutput {
  message: string
  path: string[]
  locations: GraphqlErrorLocation[]
}

/** Corpo da resposta: inteiro (`inline`) ou uma janela sobre um corpo grande
 * retido no backend (`windowed`) — o restante é lido sob demanda via
 * `readResponseBodyChunk`. */
export type ResponseBodyOutput =
  | { kind: 'inline'; body: string }
  | { kind: 'windowed'; handle: string; totalBytes: number; preview: string; previewNextOffset: number | null }

/** Como interpretar `ResponseBodyOutput.body`: texto direto, ou binário
 * (ex.: imagem) codificado em base64. */
export type ResponseBodyEncoding = 'text' | 'base64'

export interface ExecuteGraphqlRequestOutput {
  statusCode: number
  durationMs: number
  sizeBytes: number
  body: ResponseBodyOutput
  bodyEncoding: ResponseBodyEncoding
  headers: ResponseHeader[]
  /** Headers efetivamente enviados no request, incluindo os que a
   * autenticação injeta (ex.: `Authorization` resolvido de Bearer/Basic/
   * Digest/OAuth2). */
  requestHeaders: ResponseHeader[]
  cookies: Cookie[]
  connection: ConnectionInfo
  /** URL final da execução, presente só quando ela foi redirecionada. */
  finalUrl: string | null
  /** Tempo até os headers da resposta chegarem (TTFB), em ms. */
  waitingMs: number
  graphqlErrors: GraphqlErrorOutput[]
  /** Valor final de cada variável de ambiente gravada pelos scripts. */
  environmentChanges: EnvironmentChange[]
  /** Valor final de cada variável de coleção/pasta gravada pelos scripts. */
  scopedChanges: ScopedVariableChange[]
  scriptLogs: string[]
  scriptError: ScriptErrorOutput | null
  testResults: ScriptTestResult[]
}

/** Causa reconhecida de uma requisição inválida; a interface a descreve no
 * idioma do usuário (ADR 0044). Ausente quando o backend só tem a mensagem. */
export type InvalidRequestCause =
  | { type: 'emptyEndpoint' }
  | { type: 'emptyHeaderName' }
  | { type: 'invalidHeaderName'; name: string }
  | { type: 'invalidHeaderValue'; name: string }
  | { type: 'missingVariable'; name: string }
  | { type: 'emptyVariableName' }
  | { type: 'invalidVariableName' }
  | { type: 'bodyFileUnreadable'; path: string }

/** Causa reconhecida de uma falha de rede; `message` continua sendo o
 * detalhe técnico da camada HTTP. */
export type NetworkCause =
  | { type: 'invalidUrl' }
  | { type: 'hostNotFound' }
  | { type: 'connectionRefused' }
  | { type: 'connectionFailed' }
  | { type: 'tls' }
  | { type: 'tooManyRedirects' }
  | { type: 'oauth2TokenStatus'; status: number }
  | { type: 'oauth2TokenResponseInvalid' }
  | { type: 'digestBodyNotReplayable' }
  | { type: 'digestChallengeMissing' }
  | { type: 'digestChallengeInvalid' }

export type ExecuteGraphqlRequestError =
  | { kind: 'invalidRequest'; message: string; cause?: InvalidRequestCause }
  | { kind: 'script'; phase: 'preRequest' | 'postResponse'; message: string }
  | { kind: 'network'; message: string; cause?: NetworkCause }
  | { kind: 'timeout' }
  /** O corpo passou do limite de tamanho configurado; o download foi interrompido, sem resposta parcial. */
  | { kind: 'responseTooLarge'; limitBytes: number; receivedBytes: number }
  | { kind: 'invalidVariables'; message: string }
  | { kind: 'cancelled' }

export type ExecuteGraphqlRequestResult =
  | { ok: true; value: ExecuteGraphqlRequestOutput }
  | ({ ok: false; error: ExecuteGraphqlRequestError } & ScriptEffectsOnFailure)

export async function executeGraphqlRequest(input: ExecuteGraphqlRequestInput): Promise<ExecuteGraphqlRequestResult> {
  try {
    const value = await invoke<ExecuteGraphqlRequestOutput>('execute_graphql_request', { input })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, ...splitExecutionFailure<ExecuteGraphqlRequestError>(error) }
  }
}
