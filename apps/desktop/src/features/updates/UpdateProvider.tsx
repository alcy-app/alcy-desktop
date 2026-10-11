import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { cancelUpdateOperation } from '../../bindings/cancel-update-operation'
import { checkForUpdate } from '../../bindings/check-for-update'
import { downloadUpdate } from '../../bindings/download-update'
import { getUpdateSettings } from '../../bindings/get-update-settings'
import { installUpdateAndRestart } from '../../bindings/install-update-and-restart'
import { setUpdateCheckOnStartup } from '../../bindings/set-update-check-on-startup'
import type { UpdateCommandError, UpdateSettingsDto } from '../../bindings/update-types'
import { runBeforeExit } from '../../shared/app-lifecycle/before-exit'
import { FEATURE_FLAGS } from '../../shared/feature-flags'
import { useGitlab } from '../../shared/gitlab/use-gitlab'
import { isSourceReady } from './update-source'
import { UpdatesContext, type UpdatePhase, type UpdatesContextValue } from './update-context'

/** Espera após abrir o app antes da verificação automática, para não competir com a carga do workspace. */
export const STARTUP_CHECK_DELAY_MS = 5000

/**
 * Estado das atualizações do app, compartilhado pela aba "Atualizações", pelo
 * indicador da barra inferior e pela central de notificações. Verifica ao
 * abrir quando a preferência está ligada; instalar sempre depende do usuário.
 */
export function UpdateProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<UpdateSettingsDto | null>(null)
  const [phase, setPhaseState] = useState<UpdatePhase>({ kind: 'idle' })
  const [error, setError] = useState<UpdateCommandError | null>(null)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  // Espelho síncrono da etapa: as ações leem o valor atual sem depender de re-render.
  const phaseRef = useRef<UpdatePhase>(phase)
  const operationRef = useRef<string | null>(null)

  const setPhase = useCallback((next: UpdatePhase) => {
    phaseRef.current = next
    setPhaseState(next)
  }, [])

  const check = useCallback(async () => {
    const current = phaseRef.current.kind
    if (current === 'checking' || current === 'downloading' || current === 'ready' || current === 'installing') return

    const operationId = crypto.randomUUID()
    operationRef.current = operationId
    setError(null)
    setPhase({ kind: 'checking' })

    const result = await checkForUpdate(operationId)
    if (operationRef.current !== operationId) return
    operationRef.current = null

    if (result.ok) {
      setCheckedAt(Date.now())
      setPhase(result.value.release ? { kind: 'available', release: result.value.release } : { kind: 'upToDate' })
      return
    }
    setPhase({ kind: 'idle' })
    if (result.error.kind !== 'cancelled') setError(result.error)
  }, [setPhase])

  const download = useCallback(async () => {
    const current = phaseRef.current
    if (current.kind !== 'available') return

    const operationId = crypto.randomUUID()
    operationRef.current = operationId
    setError(null)
    setPhase({ kind: 'downloading', release: current.release, downloaded: 0, total: null })

    const result = await downloadUpdate(operationId, ({ downloaded, total }) => {
      if (operationRef.current !== operationId) return
      setPhase({ kind: 'downloading', release: current.release, downloaded, total })
    })
    if (operationRef.current !== operationId) return
    operationRef.current = null

    if (result.ok) {
      setPhase({ kind: 'ready', release: result.value })
      return
    }
    setPhase({ kind: 'available', release: current.release })
    if (result.error.kind !== 'cancelled') setError(result.error)
  }, [setPhase])

  const cancel = useCallback(() => {
    const operationId = operationRef.current
    if (operationId) void cancelUpdateOperation(operationId)
  }, [])

  const restart = useCallback(async () => {
    const current = phaseRef.current
    if (current.kind !== 'ready') return

    setError(null)
    setPhase({ kind: 'installing', release: current.release })
    await runBeforeExit()
    // Em caso de sucesso o app encerra antes de a chamada retornar.
    const result = await installUpdateAndRestart()
    if (result.ok) return

    setError(result.error)
    setPhase(result.error.kind === 'noPendingUpdate' ? { kind: 'available', release: current.release } : { kind: 'ready', release: current.release })
  }, [setPhase])

  const setCheckOnStartup = useCallback<UpdatesContextValue['setCheckOnStartup']>(async (enabled) => {
    const result = await setUpdateCheckOnStartup(enabled)
    if (result.ok) setSettings(result.value)
    return result
  }, [])

  // A conta usada para acessar a origem depende das contas conectadas:
  // relê as preferências quando elas mudam.
  const { accounts } = useGitlab()
  useEffect(() => {
    // Sem as preferências carregadas, a verificação ao abrir também não roda.
    if (!FEATURE_FLAGS.updates) return
    let cancelled = false
    void getUpdateSettings().then((result) => {
      if (!cancelled && result.ok) setSettings(result.value)
    })
    return () => {
      cancelled = true
    }
  }, [accounts])

  // Uma vez por abertura do app: verifica se a preferência estiver ligada e
  // a origem puder ser consultada.
  const startupHandledRef = useRef(false)
  const startupTimerRef = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!settings || startupHandledRef.current) return
    startupHandledRef.current = true
    if (settings.checkOnStartup && isSourceReady(settings.source)) {
      startupTimerRef.current = window.setTimeout(() => void check(), STARTUP_CHECK_DELAY_MS)
    }
  }, [settings, check])
  useEffect(() => () => window.clearTimeout(startupTimerRef.current), [])

  const value = useMemo<UpdatesContextValue>(
    () => ({ settings, phase, error, checkedAt, check, download, cancel, restart, setCheckOnStartup }),
    [settings, phase, error, checkedAt, check, download, cancel, restart, setCheckOnStartup],
  )

  return <UpdatesContext.Provider value={value}>{children}</UpdatesContext.Provider>
}
