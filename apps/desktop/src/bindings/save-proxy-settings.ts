import { invoke } from '@tauri-apps/api/core'
import type { ProxyCommandError, ProxySettingsDto, ProxyStatusDto } from './get-proxy-settings'

export type SaveProxySettingsResult =
  | { ok: true; value: ProxyStatusDto }
  | { ok: false; error: ProxyCommandError }

/** Aplica e persiste a configuração; falha (sem salvar) se o PAC não puder ser usado. */
export async function saveProxySettings(input: ProxySettingsDto): Promise<SaveProxySettingsResult> {
  try {
    const value = await invoke<ProxyStatusDto>('save_proxy_settings', { input })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as ProxyCommandError }
  }
}
