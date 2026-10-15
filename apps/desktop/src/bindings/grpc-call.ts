/** gRPC method and schema source of a request (spec 0129), as saved and as
 * sent over IPC. The message (JSON) travels separately. */
export type GrpcSchemaSourceDto =
  | { type: 'reflection' }
  | { type: 'protoFiles'; files: string[]; importPaths: string[] }

export interface GrpcCallDto {
  /** Fully qualified service (`package.Service`); empty until chosen. */
  service: string
  method: string
  schemaSource: GrpcSchemaSourceDto
  deadlineMs?: number | null
}
