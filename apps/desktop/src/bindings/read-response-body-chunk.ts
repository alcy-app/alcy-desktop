import { invoke } from '@tauri-apps/api/core'

export interface ReadResponseBodyChunkInput {
  handle: string
  offset: number
}

export interface ReadResponseBodyChunkOutput {
  chunk: string
  nextOffset: number | null
}

export type ReadResponseBodyChunkError = { kind: 'notFound' }

export type ReadResponseBodyChunkResult =
  | { ok: true; value: ReadResponseBodyChunkOutput }
  | { ok: false; error: ReadResponseBodyChunkError }

export async function readResponseBodyChunk(input: ReadResponseBodyChunkInput): Promise<ReadResponseBodyChunkResult> {
  try {
    const value = await invoke<ReadResponseBodyChunkOutput>('read_response_body_chunk', { input })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as ReadResponseBodyChunkError }
  }
}
