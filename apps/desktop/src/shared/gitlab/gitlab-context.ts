import { createContext } from 'react'
import type { GitlabAccountDto, GitlabCommandError } from '../../bindings/gitlab-types'

export interface GitlabContextValue {
  accounts: GitlabAccountDto[]
  /** `false` até a lista de contas salva ser lida. */
  loaded: boolean
  /** Há um login em andamento (o navegador foi aberto e o Alcy aguarda o retorno). */
  loggingIn: boolean
  login: (instanceUrl: string, clientId: string) => Promise<{ ok: true } | { ok: false; error: GitlabCommandError }>
  cancelLogin: () => void
  logout: (accountId: string) => Promise<{ ok: true } | { ok: false; error: GitlabCommandError }>
}

export const GitlabContext = createContext<GitlabContextValue | null>(null)
