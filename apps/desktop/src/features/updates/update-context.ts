import { createContext } from 'react'
import type { CommandResult } from '../../bindings/invoke-result'
import type { ReleaseDto, UpdateCommandError, UpdateSettingsDto } from '../../bindings/update-types'

/** Etapa do fluxo verificar → baixar → reiniciar. */
export type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'upToDate' }
  | { kind: 'available'; release: ReleaseDto }
  | { kind: 'downloading'; release: ReleaseDto; downloaded: number; total: number | null }
  | { kind: 'ready'; release: ReleaseDto }
  | { kind: 'installing'; release: ReleaseDto }

export type SettingsResult = CommandResult<UpdateSettingsDto, UpdateCommandError>

export interface UpdatesContextValue {
  /** `null` até as preferências salvas serem lidas. */
  settings: UpdateSettingsDto | null
  phase: UpdatePhase
  /** Erro da última ação (verificar, baixar ou instalar). */
  error: UpdateCommandError | null
  /** Instante (ms) da última verificação concluída. */
  checkedAt: number | null
  check: () => Promise<void>
  download: () => Promise<void>
  /** Cancela a verificação ou o download em andamento. */
  cancel: () => void
  /** Conclui gravações pendentes, instala o pacote baixado e reinicia o app. */
  restart: () => Promise<void>
  setCheckOnStartup: (enabled: boolean) => Promise<SettingsResult>
  setIncludePrereleases: (enabled: boolean) => Promise<SettingsResult>
}

export const UpdatesContext = createContext<UpdatesContextValue | null>(null)
