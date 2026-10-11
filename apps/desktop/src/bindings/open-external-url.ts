import { invoke } from '@tauri-apps/api/core'

export interface OpenExternalUrlError {
  kind: 'invalid' | 'failed'
  message: string
}

export type OpenExternalUrlResult = { ok: true } | { ok: false; error: OpenExternalUrlError }

/** Abre um link http(s) no navegador padrão do sistema, fora da janela do app. */
export async function openExternalUrl(url: string): Promise<OpenExternalUrlResult> {
  try {
    await invoke('open_external_url', { input: { url } })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error as OpenExternalUrlError }
  }
}
