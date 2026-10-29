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
  /** Selected requests in execution order. */
  plan: RunPlanEntry[]
  options: CollectionRunOptionsDto
  dataFilePath: string | null
  environmentVariables: EnvironmentVariableDto[]
  environmentName: string | null
}

interface UseCollectionRunParams {
  rootPath: string
  /** Flush collection edits before the backend reloads the requests from disk. */
  onBeforeRun: () => Promise<void>
  onEnvironmentChanges: (changes: EnvironmentChange[]) => void
  /** Collection/folder variables written by scripts (ADR 0031). */
  onScopedChanges?: (changes: ScopedVariableChange[]) => void
  onRunFinished: () => void
  /** Every finished request, unless logging is disabled. */
  onStepLogged?: (step: RunStepDto) => void
}

/** Batch channel events per animation frame so long runs do not rerender
 * the entire result list for every individual event. */
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
  const runningRef = useRef(false)
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

  useEffect(() => () => {
    if (runningRef.current && runIdRef.current) void cancelCollectionRun(runIdRef.current)
    runIdRef.current = null
    runningRef.current = false
  }, [rootPath])

  const start = useCallback(
    async ({ scopeName, plan, options, dataFilePath, environmentVariables, environmentName }: StartRunParams) => {
      if (runningRef.current) throw new Error('This runner is already running.')
      const runId = crypto.randomUUID()
      runIdRef.current = runId
      runningRef.current = true
      pendingRef.current = []
      setStartError(null)
      setState(startedRunState(runId, Date.now(), plan))
      try { await onBeforeRun() } catch (error) {
        runningRef.current = false
        setState(idleRunState)
        setStartError({ kind: 'storage', message: error instanceof Error ? error.message : String(error) })
        throw error
      }
      if (runIdRef.current !== runId) throw new Error('The runner was closed before it started.')

      const completion = executeCollectionRun(
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
            runningRef.current = false
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
      void completion.then((result) => {
        if (!result.ok && runIdRef.current === runId) {
          runningRef.current = false
          setStartError(result.error)
          setState(idleRunState)
        }
      })
      return runId
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
