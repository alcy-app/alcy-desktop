import type {
  ExecuteGraphqlRequestError,
  ExecuteGraphqlRequestOutput,
  GraphqlErrorOutput,
} from '../../bindings/execute-graphql-request'
import type {
  ExecuteRestRequestError,
  ExecuteRestRequestOutput,
  HttpMethodInput,
  RawBodyLanguage,
} from '../../bindings/execute-rest-request'
import type { GrpcStreamState } from './grpc-stream'
import type { ExecuteGrpcRequestOutput } from '../../bindings/execute-grpc-request'
import type { GrpcCommandError, GrpcSchemaSummary } from '../../bindings/load-grpc-schema'
import type { LoadSchemaError, LoadSchemaOutput } from '../../bindings/load-schema'
import type { GrpcCallState, RequestContent } from './collection-tree'

export type { HttpMethodInput, RawBodyLanguage }

/** Protocol of an open tab, separate from the persisted collection request type even when their values coincide. */
export type WorkbenchProtocol = 'graphql' | 'rest' | 'grpc'

export type RequestTabId =
  | 'docs'
  | 'message'
  | 'query'
  | 'variables'
  | 'params'
  | 'body'
  | 'scripts'
  | 'headers'
  | 'authorization'
  | 'schema'
export type ResponseTabId = 'body' | 'headers' | 'errors' | 'tests'

export interface WorkbenchEnvironment {
  id: string
  name: string
}

export interface HeaderEntry {
  id: string
  name: string
  value: string
  enabled: boolean
}

/** A Params row derived from endpointUrl and serialized back into it, never persisted separately. */
export interface ParamEntry {
  id: string
  name: string
  value: string
  enabled: boolean
}

/** Value of a named route placeholder. Editing the name also updates its URL token. */
export interface RouteParamEntry {
  id: string
  name: string
  value: string
}

export type BodyType = 'none' | 'formData' | 'urlencoded' | 'raw' | 'binary'

export interface UrlEncodedEntry {
  id: string
  name: string
  value: string
  enabled: boolean
}

export interface FormDataEntry {
  id: string
  name: string
  enabled: boolean
  kind: 'text' | 'file'
  /** Value when kind is text. */
  value: string
  /** Absolute path when kind is file. */
  filePath: string
}

/** REST body edits retain every format so switching does not discard input. Only the active format is sent and saved. */
export interface BodyState {
  type: BodyType
  raw: string
  rawLanguage: RawBodyLanguage
  urlEncoded: UrlEncodedEntry[]
  formData: FormDataEntry[]
  binaryFilePath: string
}

export type AuthorizationType = 'inherit' | 'none' | 'customHeader' | 'bearer' | 'basic' | 'digest' | 'oauth2ClientCredentials'

export interface AuthorizationState {
  type: AuthorizationType
  headerName: string
  headerValue: string
  token: string
  username: string
  password: string
  clientId: string
  clientSecret: string
  tokenUrl: string
  scope: string
}

export type ExecutionSuccess = ExecuteGraphqlRequestOutput | ExecuteRestRequestOutput | ExecuteGrpcRequestOutput
export type ExecutionFailure = ExecuteGraphqlRequestError | ExecuteRestRequestError | GrpcCommandError

/** HTTP results (REST, GraphQL); `null` for a gRPC one, which has no HTTP status. */
export function httpResultOf(result: ExecutionSuccess): ExecuteGraphqlRequestOutput | ExecuteRestRequestOutput | null {
  return 'statusCode' in result ? result : null
}

/** gRPC result, or `null` for the HTTP ones. */
export function grpcResultOf(result: ExecutionSuccess | null | undefined): ExecuteGrpcRequestOutput | null {
  return result && 'messageCount' in result ? result : null
}

/** GraphQL errors, or null for a missing result or a REST/gRPC execution. */
export function graphqlErrorsOf(result: ExecutionSuccess | null | undefined): GraphqlErrorOutput[] | null {
  if (!result || !('graphqlErrors' in result)) return null
  return result.graphqlErrors
}

export type ExecutionState =
  | { status: 'idle' }
  /** Date.now() at send time, used by the live response timer. */
  | { status: 'loading'; startedAt: number }
  /** A history entry that retained only status, duration and size. */
  | { status: 'success'; result: ExecutionSuccess; responseNotStored?: boolean }
  | { status: 'error'; error: ExecutionFailure }

export type GrpcSchemaLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; schema: GrpcSchemaSummary }
  | { status: 'error'; error: GrpcCommandError }

export type SchemaLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; schema: LoadSchemaOutput }
  | { status: 'error'; error: LoadSchemaError }

/** Open tabs keep independent editing, execution and schema state; unsaved drafts have a null requestId. */
/** Inline flow request node edited in a tab (spec 0086). */
export interface FlowNodeRef {
  flowId: string
  nodeId: string
}

export interface WorkbenchTab {
  id: string
  requestId: string | null
  /** Inline flow request destination: Save writes to the node rather than a collection. */
  flowNodeRef?: FlowNodeRef
  name: string
  /** False for a replaceable italic preview tab; editing or double-clicking pins it for the session. */
  pinned: boolean
  /** User-fixed tabs come first and survive closing unfixed tabs. Persisted in the tab session. */
  fixed?: boolean
  endpointUrl: string
  activeSection: RequestTabId
  protocol: WorkbenchProtocol
  method: HttpMethodInput
  query: string
  variables: string
  /** REST body, parallel to the GraphQL-only query and variables fields. */
  body: BodyState
  /** Request JavaScript (spec 0054); empty means no script. */
  preRequestScript: string
  postResponseScript: string
  headers: HeaderEntry[]
  params: ParamEntry[]
  routeParams: RouteParamEntry[]
  authorization: AuthorizationState
  /** Content at the last load/save, compared field by field to compute dirty state. */
  savedContent: RequestContent
  /** Unsaved edits, recalculated per affected tab in updateTab rather than serializing every tab during render. */
  dirty: boolean
  execution: ExecutionState
  executionId: string | null
  /** ID of the send that produced the displayed response, also its history entry ID. */
  lastSendId: string | null
  schema: SchemaLoadState
  schemaExecutionId: string | null
  /** gRPC call of the tab (spec 0129); default for the other protocols. */
  grpc: GrpcCallState
  grpcSchema: GrpcSchemaLoadState
  grpcStream?: GrpcStreamState
}
