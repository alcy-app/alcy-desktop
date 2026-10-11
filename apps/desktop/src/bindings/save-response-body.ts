import { invoke } from '@tauri-apps/api/core'
import type { ResponseBodyEncoding } from './execute-graphql-request'

/** De onde o backend lê o corpo: inteiro (`inline`, já cruzou a IPC) ou pelo
 * handle de um corpo grande retido no backend (`windowed`) — o corpo completo
 * não volta pela IPC. */
export type SaveResponseBodySource = { kind: 'inline'; body: string } | { kind: 'windowed'; handle: string }

export interface SaveResponseBodyInput {
  path: string
  encoding: ResponseBodyEncoding
  source: SaveResponseBodySource
}

export type SaveResponseBodyError = { kind: 'notFound' } | { kind: 'invalid' | 'storage'; message: string }

export type SaveResponseBodyResult = { ok: true } | { ok: false; error: SaveResponseBodyError }

/** Grava o corpo da resposta no arquivo escolhido ("Baixar resposta"). */
export async function saveResponseBody(input: SaveResponseBodyInput): Promise<SaveResponseBodyResult> {
  try {
    await invoke('save_response_body', { input })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error as SaveResponseBodyError }
  }
}
