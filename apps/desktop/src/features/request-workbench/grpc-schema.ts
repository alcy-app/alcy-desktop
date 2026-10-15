import type { SchemaNodeDto } from '../../bindings/get-request-docs'
import type { GrpcMethodSummary, GrpcSchemaSummary } from '../../bindings/load-grpc-schema'
import type { BodySchema } from './schema-completions'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A node of the JSON Schema the backend describes a gRPC message with,
 * in the shape the JSON body completions read (spec 0129). */
function toNode(value: unknown): SchemaNodeDto {
  const schema = isRecord(value) ? value : {}
  const types = Array.isArray(schema.type) ? schema.type.map(String) : typeof schema.type === 'string' ? [schema.type] : []
  const properties = isRecord(schema.properties)
    ? Object.entries(schema.properties).map(([name, property]) => ({ name, schema: toNode(property) }))
    : []
  return {
    refName: null,
    types,
    format: schema.contentEncoding === 'base64' ? 'byte' : null,
    title: null,
    description: '',
    nullable: false,
    deprecated: false,
    readOnly: false,
    writeOnly: false,
    enumValues: Array.isArray(schema.enum) ? schema.enum.map(String) : [],
    default: null,
    example: null,
    properties,
    required: [],
    items: schema.items === undefined ? null : toNode(schema.items),
    additionalProperties: isRecord(schema.additionalProperties) ? toNode(schema.additionalProperties) : null,
    allOf: [],
    oneOf: [],
    anyOf: [],
  }
}

/** Completions for a method's input message. */
export function grpcMessageSchema(method: GrpcMethodSummary): BodySchema {
  return { root: toNode(method.inputSchema), schemas: {} }
}

export function findGrpcMethod(schema: GrpcSchemaSummary, service: string, method: string): GrpcMethodSummary | null {
  return schema.services.find((candidate) => candidate.name === service)?.methods.find((candidate) => candidate.name === method) ?? null
}

/** `package.Service` → `Service`, for compact labels. */
export function shortServiceName(service: string): string {
  return service.slice(service.lastIndexOf('.') + 1)
}
