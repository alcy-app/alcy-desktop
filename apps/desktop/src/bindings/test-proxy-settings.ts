import { invoke } from '@tauri-apps/api/core'
import type { ProxyCommandError, ProxySettingsDto } from './get-proxy-settings'

export type TestProxySettingsResult = { ok: true } | { ok: false; error: ProxyCommandError }

/** Valida a configuração (baixa e avalia o PAC) sem aplicá-la nem salvá-la. */
export async function testProxySettings(input: ProxySettingsDto): Promise<TestProxySettingsResult> {
  try {
    await invoke<null>('test_proxy_settings', { input })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error as ProxyCommandError }
  }
}
