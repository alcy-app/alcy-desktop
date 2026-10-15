import { invoke } from '@tauri-apps/api/core'
import type { GrpcCallDto } from './grpc-call'
import type { AuthenticationInput, HeaderInput } from './execute-graphql-request'
import type { HttpMethodInput, RestBodyInput } from './execute-rest-request'

export interface RouteParameterDto {
  name: string
  value: string
}

export interface SavedRequestDto {
  id: string
  name: string
  protocol: string
  endpoint: string
  method: HttpMethodInput
  /** Query GraphQL, ou o texto do corpo REST. */
  body: string
  /** Corpo REST estruturado; ausente em GraphQL e em DTOs antigos. */
  restBody?: RestBodyInput | null
  variables: string
  headers: HeaderInput[]
  authentication: AuthenticationInput
  preRequestScript: string
  postResponseScript: string
  /** Ausente em requisições salvas antes do suporte a placeholders `:nome`. */
  routeParams?: RouteParameterDto[]
  /** Documentação importada desta chamada (ADR 0035); ausente em DTOs antigos. */
  docsRef?: DocsRefDto | null
  /** gRPC method and schema source (spec 0129); absent for other protocols. */
  grpc?: GrpcCallDto | null
}

/** Aponta para uma operação em `alcy-api-docs.json` — não usa o id da requisição. */
export interface DocsRefDto {
  sourceId: string
  operationId: string
}

/** Variável de coleção/pasta — escopo local, nunca sensível (ADR 0031). */
export interface ScopedVariableDto {
  name: string
  value: string
}

export interface FolderDto {
  id: string
  name: string
  folders: FolderDto[]
  requests: SavedRequestDto[]
  authentication: AuthenticationInput
  /** Ausente em DTOs antigos. */
  variables?: ScopedVariableDto[]
}

/** Paleta fixa de cores de rótulo (ADR 0060), legível nos temas claro e escuro. */
export type LabelColor = 'gray' | 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'pink'

/** Rótulo de uma collection, compartilhado com o time pelo arquivo de collections (ADR 0060). */
export interface CollectionLabelDto {
  name: string
  color: LabelColor
}

export interface CollectionDto {
  id: string
  name: string
  folders: FolderDto[]
  requests: SavedRequestDto[]
  authentication: AuthenticationInput
  /** Ausente em DTOs antigos. */
  variables?: ScopedVariableDto[]
  /** Ausente em DTOs antigos e em collections sem rótulos. */
  labels?: CollectionLabelDto[]
}

export type CollectionsError = { kind: 'invalid'; message: string } | { kind: 'storage'; message: string }

export type ListCollectionsResult = { ok: true; value: CollectionDto[] } | { ok: false; error: CollectionsError }

export async function listCollections(rootPath: string): Promise<ListCollectionsResult> {
  try {
    const value = await invoke<CollectionDto[]>('list_collections', { input: { rootPath } })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as CollectionsError }
  }
}
