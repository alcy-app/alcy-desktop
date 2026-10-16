import type { AuthenticationInput, HeaderInput, InvalidRequestCause, VariableScopeInput } from './execute-graphql-request'
import type { GrpcSchemaSourceDto } from './grpc-call'
import { invokeResult, type CommandResult } from './invoke-result'
import type { EnvironmentVariableDto } from './list-environments'

export type GrpcMethodKind = 'unary' | 'serverStreaming' | 'clientStreaming' | 'bidiStreaming'

export interface GrpcMethodSummary {
  name: string
  kind: GrpcMethodKind
  inputType: string
  outputType: string
  /** The input message with every field at its default value, as JSON. */
  inputTemplate: string
  /** JSON Schema of the input message, for completion in the editor. */
  inputSchema: unknown
}

export interface GrpcServiceSummary {
  name: string
  methods: GrpcMethodSummary[]
}

export interface GrpcSchemaSummary {
  services: GrpcServiceSummary[]
}

export interface GrpcConnectionInput {
  rootPath: string
  endpoint: string
  schemaSource: GrpcSchemaSourceDto
  headers: HeaderInput[]
  authentication: AuthenticationInput
  requestId: string | null
  environmentVariables: EnvironmentVariableDto[]
  variableScopes: VariableScopeInput[]
}

export type GrpcCommandError =
  | { kind: 'script'; phase: 'preRequest' | 'postResponse'; message: string }
  | { kind: 'invalidRequest'; message: string; cause?: InvalidRequestCause }
  | { kind: 'connection'; message: string }
  | { kind: 'schema'; message: string }
  | { kind: 'cancelled' }

export interface LoadGrpcSchemaInput extends GrpcConnectionInput {
  executionId: string
  forceRefresh: boolean
}

/** Services and methods of a server, from reflection or `.proto` files;
 * cancellable with `cancel_graphql_request` and the same `executionId`. */
export function loadGrpcSchema(input: LoadGrpcSchemaInput): Promise<CommandResult<GrpcSchemaSummary, GrpcCommandError>> {
  return invokeResult('load_grpc_schema', { input })
}
