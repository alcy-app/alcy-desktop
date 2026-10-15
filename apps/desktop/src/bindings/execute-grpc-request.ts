import type { ResponseBodyOutput } from './execute-graphql-request'
import { invokeResult, type CommandResult } from './invoke-result'
import type { GrpcCommandError, GrpcConnectionInput } from './load-grpc-schema'

export interface GrpcStatusOutput {
  code: number
  /** Canonical name (`OK`, `NOT_FOUND`, …). */
  codeName: string
  message: string
}

export interface GrpcMetadataEntry {
  name: string
  value: string
}

export interface ExecuteGrpcRequestInput extends GrpcConnectionInput {
  executionId: string
  service: string
  method: string
  deadlineMs: number | null
  /** The request message, as JSON. */
  message: string
  tabId: string | null
}

export interface ExecuteGrpcRequestOutput {
  /** Tells a gRPC result apart from the HTTP ones in a union. */
  status: GrpcStatusOutput
  durationMs: number
  sizeBytes: number
  messageCount: number
  /** The received message as JSON; a JSON array when there are several. */
  body: ResponseBodyOutput
  headers: GrpcMetadataEntry[]
  trailers: GrpcMetadataEntry[]
}

/** Calls a gRPC method; cancellable with `cancel_graphql_request`. */
export function executeGrpcRequest(
  input: ExecuteGrpcRequestInput,
): Promise<CommandResult<ExecuteGrpcRequestOutput, GrpcCommandError>> {
  return invokeResult('execute_grpc_request', { input })
}
