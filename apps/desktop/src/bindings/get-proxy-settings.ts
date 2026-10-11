import { invoke } from '@tauri-apps/api/core'

export type ProxyMode = 'disabled' | 'system' | 'pac'

export interface ProxySettingsDto {
  mode: ProxyMode
  pacUrl?: string | null
}

export interface ProxyStatusDto extends ProxySettingsDto {
  /** Preenchido quando a configuração salva não pôde ser aplicada (ex.: PAC inacessível). */
  error: string | null
}

export type ProxyCommandError =
  | { kind: 'invalid'; message: string }
  | { kind: 'pac'; message: string }
  | { kind: 'storage'; message: string }

export type GetProxySettingsResult =
  | { ok: true; value: ProxyStatusDto }
  | { ok: false; error: ProxyCommandError }

export async function getProxySettings(): Promise<GetProxySettingsResult> {
  try {
    const value = await invoke<ProxyStatusDto>('get_proxy_settings')
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as ProxyCommandError }
  }
}
