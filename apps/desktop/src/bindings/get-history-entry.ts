import { invoke } from '@tauri-apps/api/core'
import type { GrpcCallDto } from './grpc-call'
import type {
  AuthenticationInput,
  GraphqlErrorOutput,
  HeaderInput,
  ResponseBodyEncoding,
  ResponseBodyOutput,
  ResponseHeader,
} from './execute-graphql-request'
import type { HttpMethodInput, RestBodyInput } from './execute-rest-request'
import type { HistoryError } from './list-history'

export type HistoryOutcomeDetail =
  | {
      type: 'success'
      statusCode: number
      durationMs: number
      sizeBytes: number
      body: ResponseBodyOutput
      bodyEncoding: ResponseBodyEncoding
      headers: ResponseHeader[]
      graphqlErrors: GraphqlErrorOutput[]
      /** O histórico guardou só parte do corpo (teto de persistência); `sizeBytes` é o tamanho original. */
      bodyTruncated: boolean
      /** `false` quando o histórico guardou só status, tempo e tamanho ("Salvar respostas" desligado). */
      responseStored: boolean
    }
  | { type: 'failed'; kind: 'network' | 'timeout'; message: string }

export interface HistoryEntryDetailDto {
  id: string
  protocol: string
  endpoint: string
  method: HttpMethodInput
  body: string
  /** Corpo REST estruturado; `null` para GraphQL. */
  restBody: RestBodyInput | null
  variables: string
  headers: HeaderInput[]
  authentication: AuthenticationInput
  executedAtMs: number
  outcome: HistoryOutcomeDetail
  /** gRPC method and schema source; absent for the other protocols. */
  grpc?: GrpcCallDto | null
}

export type GetHistoryEntryResult = { ok: true; value: HistoryEntryDetailDto } | { ok: false; error: HistoryError }

export async function getHistoryEntry(rootPath: string, id: string): Promise<GetHistoryEntryResult> {
  try {
    const value = await invoke<HistoryEntryDetailDto>('get_history_entry', { input: { rootPath, id } })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as HistoryError }
  }
}
