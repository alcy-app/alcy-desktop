import { invoke } from '@tauri-apps/api/core'
import type {
  AuthenticationInput,
  HeaderInput,
  InvalidRequestCause,
  NetworkCause,
  VariableScopeInput,
} from './execute-graphql-request'
import type { EnvironmentVariableDto } from './list-environments'

export interface SchemaEnumValue {
  name: string
  description: string | null
  isDeprecated: boolean
  deprecationReason: string | null
}

export interface SchemaInputValue {
  name: string
  description: string | null
  typeDisplay: string
  typeName: string | null
  defaultValue: string | null
}

export interface SchemaField {
  name: string
  description: string | null
  args: SchemaInputValue[]
  typeDisplay: string
  typeName: string | null
  isDeprecated: boolean
  deprecationReason: string | null
}

export interface SchemaType {
  name: string
  kind: string
  description: string | null
  fields: SchemaField[]
  inputFields: SchemaInputValue[]
  enumValues: SchemaEnumValue[]
  interfaces: string[]
  possibleTypes: string[]
}

export interface SchemaDirective {
  name: string
  description: string | null
  locations: string[]
  args: SchemaInputValue[]
}

export interface LoadSchemaOutput {
  queryType: string | null
  mutationType: string | null
  subscriptionType: string | null
  types: SchemaType[]
  directives: SchemaDirective[]
}

export interface LoadSchemaInput {
  executionId: string
  endpointUrl: string
  headers: HeaderInput[]
  authentication: AuthenticationInput
  /** Workspace e requisição salva de origem; o backend usa para resolver `inherit`. */
  rootPath?: string | null
  requestId?: string | null
  environmentVariables: EnvironmentVariableDto[]
  /** Camadas de variáveis da coleção/pastas da requisição (ADR 0031). */
  variableScopes: VariableScopeInput[]
  forceRefresh: boolean
}

export type LoadSchemaError =
  | { kind: 'invalidRequest'; message: string; cause?: InvalidRequestCause }
  | { kind: 'network'; message: string; cause?: NetworkCause }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  /** `message` é o detalhe técnico (erros do servidor ou do JSON); vazio quando falta `__schema`. */
  | { kind: 'invalidResponse'; message: string; cause: SchemaResponseCause }

/** Por que a resposta de introspection não serve como schema (ADR 0044). */
export type SchemaResponseCause = { type: 'serverErrors' } | { type: 'notJson' } | { type: 'missingSchema' }

export type LoadSchemaResult = { ok: true; value: LoadSchemaOutput } | { ok: false; error: LoadSchemaError }

export async function loadSchema(input: LoadSchemaInput): Promise<LoadSchemaResult> {
  try {
    const value = await invoke<LoadSchemaOutput>('load_schema', { input })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as LoadSchemaError }
  }
}
