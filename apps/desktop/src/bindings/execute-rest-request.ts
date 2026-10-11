import { invoke } from '@tauri-apps/api/core'
import type {
  AuthenticationInput,
  ConnectionInfo,
  Cookie,
  EnvironmentChange,
  ScriptErrorOutput,
  HeaderInput,
  InvalidRequestCause,
  NetworkCause,
  ResponseBodyEncoding,
  ResponseBodyOutput,
  ResponseHeader,
  ScopedVariableChange,
  ScriptEffectsOnFailure,
  ScriptTestResult,
  VariableScopeInput,
} from './execute-graphql-request'
import { splitExecutionFailure } from './execute-graphql-request'
import type { EnvironmentVariableDto } from './list-environments'

export type HttpMethodInput = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options'

export type RawBodyLanguage = 'text' | 'javascript' | 'json' | 'html' | 'xml'

export type FormDataFieldInput =
  | { kind: 'text'; name: string; enabled: boolean; value: string }
  | { kind: 'file'; name: string; enabled: boolean; filePath: string }

export interface UrlEncodedFieldInput {
  name: string
  value: string
  enabled: boolean
}

/** Corpo de uma requisição REST. Arquivos (binary e campos de arquivo do
 * form-data) cruzam a IPC só como caminho — o backend lê o conteúdo. */
export type RestBodyInput =
  | { type: 'none' }
  | { type: 'raw'; content: string; rawLanguage: RawBodyLanguage }
  | { type: 'urlencoded'; fields: UrlEncodedFieldInput[] }
  | { type: 'formData'; fields: FormDataFieldInput[] }
  | { type: 'binary'; filePath: string }

export interface RouteParameterInput {
  name: string
  value: string
}

export interface ExecuteRestRequestInput {
  executionId: string
  rootPath: string
  endpointUrl: string
  routeParams: RouteParameterInput[]
  method: HttpMethodInput
  body: RestBodyInput
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

export interface ExecuteRestRequestOutput {
  statusCode: number
  durationMs: number
  sizeBytes: number
  body: ResponseBodyOutput
  bodyEncoding: ResponseBodyEncoding
  headers: ResponseHeader[]
  requestHeaders: ResponseHeader[]
  cookies: Cookie[]
  connection: ConnectionInfo
  finalUrl: string | null
  waitingMs: number
  environmentChanges: EnvironmentChange[]
  scopedChanges: ScopedVariableChange[]
  scriptLogs: string[]
  scriptError: ScriptErrorOutput | null
  testResults: ScriptTestResult[]
}

export type ExecuteRestRequestError =
  | { kind: 'invalidRequest'; message: string; cause?: InvalidRequestCause }
  | { kind: 'script'; phase: 'preRequest' | 'postResponse'; message: string }
  | { kind: 'network'; message: string; cause?: NetworkCause }
  | { kind: 'timeout' }
  /** O corpo passou do limite de tamanho configurado; o download foi interrompido, sem resposta parcial. */
  | { kind: 'responseTooLarge'; limitBytes: number; receivedBytes: number }
  | { kind: 'cancelled' }

export type ExecuteRestRequestResult =
  | { ok: true; value: ExecuteRestRequestOutput }
  | ({ ok: false; error: ExecuteRestRequestError } & ScriptEffectsOnFailure)

export async function executeRestRequest(input: ExecuteRestRequestInput): Promise<ExecuteRestRequestResult> {
  try {
    const value = await invoke<ExecuteRestRequestOutput>('execute_rest_request', { input })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, ...splitExecutionFailure<ExecuteRestRequestError>(error) }
  }
}
