import { invoke } from '@tauri-apps/api/core'

export type CommandResult<T, E> = { ok: true; value: T } | { ok: false; error: E }

/** Chama um command Tauri e devolve o erro estruturado em vez de lançá-lo. */
export async function invokeResult<T, E>(command: string, args?: Record<string, unknown>): Promise<CommandResult<T, E>> {
  try {
    const value = await invoke<T>(command, args)
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as E }
  }
}
