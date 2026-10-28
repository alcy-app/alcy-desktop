import { createContext } from 'react'
import type { GitlabCommandError } from '../../bindings/gitlab-types'
import type { OnedriveAccountDto } from '../../bindings/onedrive-types'

export interface OnedriveContextValue {
  accounts: OnedriveAccountDto[]
  /** `false` até a lista de contas salva ser lida. */
  loaded: boolean
  /** Há um login em andamento (o navegador foi aberto e o Alcy aguarda o retorno). */
  loggingIn: boolean
  login: (clientId: string, tenant: string) => Promise<{ ok: true } | { ok: false; error: GitlabCommandError }>
  cancelLogin: () => void
  logout: (accountId: string) => Promise<{ ok: true } | { ok: false; error: GitlabCommandError }>
}

export const OnedriveContext = createContext<OnedriveContextValue | null>(null)
