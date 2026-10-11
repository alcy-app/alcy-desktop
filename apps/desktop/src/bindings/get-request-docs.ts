import { invokeResult, type CommandResult } from './invoke-result'
import type { DocsRefDto } from './list-collections'

export type DocsSourceKind = 'openapi' | 'postman' | 'insomnia' | 'bruno'
export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie'

/** Subconjunto de JSON Schema. `enumValues`, `default` e `example` são texto
 * JSON literal (ex. `"available"`, `10`, `true`). `refName` aponta para um
 * schema nomeado em `RequestDocsDto.schemas`. */
export interface SchemaNodeDto {
  refName: string | null
  types: string[]
  format: string | null
  title: string | null
  description: string
  nullable: boolean
  deprecated: boolean
  readOnly: boolean
  writeOnly: boolean
  enumValues: string[]
  default: string | null
  example: string | null
  properties: { name: string; schema: SchemaNodeDto }[]
  required: string[]
  items: SchemaNodeDto | null
  additionalProperties: SchemaNodeDto | null
  allOf: SchemaNodeDto[]
  oneOf: SchemaNodeDto[]
  anyOf: SchemaNodeDto[]
}

export interface ParameterDocDto {
  name: string
  location: ParameterLocation
  required: boolean
  deprecated: boolean
  description: string
  schema: SchemaNodeDto | null
  example: string | null
}

export interface MediaDocDto {
  mediaType: string
  schema: SchemaNodeDto | null
  example: string | null
}

export interface RequestDocsDto {
  sourceTitle: string
  sourceKind: DocsSourceKind
  summary: string
  description: string
  deprecated: boolean
  parameters: ParameterDocDto[]
  requestBody: { description: string; required: boolean; content: MediaDocDto[] } | null
  responses: { status: string; description: string; content: MediaDocDto[] }[]
  /** Schemas nomeados alcançáveis a partir desta operação. */
  schemas: Record<string, SchemaNodeDto>
}

export type ApiDocsCommandError = { kind: 'storage'; message: string }

/** Documentação importada de uma chamada; `null` quando a fonte não existe
 * neste workspace. Só a operação pedida cruza o IPC (ADR 0035). */
export function getRequestDocs(
  rootPath: string,
  docsRef: DocsRefDto,
): Promise<CommandResult<RequestDocsDto | null, ApiDocsCommandError>> {
  return invokeResult('get_request_docs', {
    input: { rootPath, sourceId: docsRef.sourceId, operationId: docsRef.operationId },
  })
}
