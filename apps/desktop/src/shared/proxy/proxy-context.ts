import { createContext } from 'react'
import type { ProxyCommandError, ProxySettingsDto } from '../../bindings/get-proxy-settings'

export interface ProxyContextValue {
  settings: ProxySettingsDto
  /** Erro ao aplicar a configuração salva na abertura do app, se houve. */
  applyError: string | null
  save: (input: ProxySettingsDto) => Promise<{ ok: true } | { ok: false; error: ProxyCommandError }>
  test: (input: ProxySettingsDto) => Promise<{ ok: true } | { ok: false; error: ProxyCommandError }>
}

export const ProxyContext = createContext<ProxyContextValue | null>(null)
