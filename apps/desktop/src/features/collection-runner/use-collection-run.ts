import { useCallback, useEffect, useRef, useState } from 'react'
import { cancelCollectionRun } from '../../bindings/cancel-collection-run'
import { executeCollectionRun } from '../../bindings/execute-collection-run'
import type {
  CollectionRunEventDto,
  CollectionRunOptionsDto,
  ExecuteCollectionRunError,
  RunStepDto,
} from '../../bindings/execute-collection-run'
import type { EnvironmentChange, ScopedVariableChange } from '../../bindings/execute-graphql-request'
import type { EnvironmentVariableDto } from '../../bindings/list-environments'
import { applyRunEvents, idleRunState, startedRunState } from './collection-run-state'
import type { CollectionRunState, RunPlanEntry } from './collection-run-state'

export interface StartRunParams {
  scopeName: string
  /** Requisições selecionadas, na ordem de execução. */
  plan: RunPlanEntry[]
  options: CollectionRunOptionsDto
  dataFilePath: string | null
  environmentVariables: EnvironmentVariableDto[]
  environmentName: string | null
}

interface UseCollectionRunParams {
  rootPath: string
  /** Grava o save pendente das coleções: o backend lê as requisições do disco. */
  onBeforeRun: () => Promise<void>
  onEnvironmentChanges: (changes: EnvironmentChange[]) => void
  /** Variáveis de coleção/pasta gravadas pelos scripts (ADR 0031). */
  onScopedChanges?: (changes: ScopedVariableChange[]) => void
  onRunFinished: () => void
  /** Cada requisição terminada, quando os logs não estão desativados. */
  onStepLogged?: (step: RunStepDto) => void
}

/** Estado de um run do runner de coleções. Os eventos do canal são
 * agrupados por frame antes de virar estado: um run longo emite milhares
 * de eventos e cada um re-renderizaria a lista inteira. */
export function useCollectionRun({
  rootPath,
  onBeforeRun,
  onEnvironmentChanges,
  onScopedChanges,
  onRunFinished,
  onStepLogged,
}: UseCollectionRunParams) {
  const [state, setState] = useState<CollectionRunState>(idleRunState)
  const [startError, setStartError] = useState<ExecuteCollectionRunError | null>(null)
  const runIdRef = useRef<string | null>(null)
  const pendingRef = useRef<CollectionRunEventDto[]>([])
  const frameRef = useRef<number | null>(null)
  const callbacksRef = useRef({ onEnvironmentChanges, onScopedChanges, onRunFinished, onStepLogged })
  useEffect(() => {
    callbacksRef.current = { onEnvironmentChanges, onScopedChanges, onRunFinished, onStepLogged }
  })

  const flush = useCallback(() => {
    frameRef.current = null
    const events = pendingRef.current
    pendingRef.current = []
    if (events.length > 0) setState((current) => applyRunEvents(current, events, Date.now()))
  }, [])

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    },
    [],
  )

  const start = useCallback(
    async ({ scopeName, plan, options, dataFilePath, environmentVariables, environmentName }: StartRunParams) => {
      const runId = crypto.randomUUID()
      runIdRef.current = runId
      pendingRef.current = []
      setStartError(null)
      setState(startedRunState(runId, Date.now(), plan))
      await onBeforeRun()

      const result = await executeCollectionRun(
        {
          runId,
          rootPath,
          scopeName,
          requestIds: plan.map((entry) => entry.requestId),
          options,
          environmentVariables,
          dataFilePath,
          environmentName,
        },
        (event) => {
          if (runIdRef.current !== runId) return
          if (event.type === 'requestFinished' && !options.disableLogs) {
            callbacksRef.current.onStepLogged?.(event.step)
          }
          pendingRef.current.push(event)
          if (event.type === 'runFinished') {
            if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
            flush()
            if (event.environmentChanges.length > 0) {
              callbacksRef.current.onEnvironmentChanges(event.environmentChanges)
            }
            if (event.scopedChanges.length > 0) callbacksRef.current.onScopedChanges?.(event.scopedChanges)
            callbacksRef.current.onRunFinished()
            return
          }
          if (frameRef.current === null) frameRef.current = requestAnimationFrame(flush)
        },
      )
      if (!result.ok && runIdRef.current === runId) {
        // Erro antes do run começar: nenhum evento chegou.
        setStartError(result.error)
        setState(idleRunState)
      }
    },
    [rootPath, onBeforeRun, flush],
  )

  const cancel = useCallback(() => {
    if (runIdRef.current) void cancelCollectionRun(runIdRef.current)
  }, [])

  const reset = useCallback(() => {
    runIdRef.current = null
    pendingRef.current = []
    setStartError(null)
    setState(idleRunState)
  }, [])

  return { state, startError, start, cancel, reset }
}
