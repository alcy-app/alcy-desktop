import { useCallback, useRef, useState } from 'react'
import { cancelLoadFlow } from '../../bindings/cancel-load-flow'
import { executeLoadFlow } from '../../bindings/execute-load-flow'
import type { LoadRunEventDto } from '../../bindings/execute-load-flow'
import { getLoadRunHistory } from '../../bindings/get-load-run-history'
import type { LoadRunDetailDto } from '../../bindings/get-load-run-history'
import { useLanguage } from '../../shared/i18n/use-language'
import { useToast } from '../../shared/ui/use-toast'

export interface LoadRunProgressState {
  activeVus: number
  plannedVus: number
  completedIterations: number
  droppedIterations: number
  requests: number
  failedRequests: number
  checksPassed: number
  checksFailed: number
  elapsedMs: number
}

const INITIAL_PROGRESS: LoadRunProgressState = {
  activeVus: 0,
  plannedVus: 0,
  completedIterations: 0,
  droppedIterations: 0,
  requests: 0,
  failedRequests: 0,
  checksPassed: 0,
  checksFailed: 0,
  elapsedMs: 0,
}

/** Executa somente o flow persistido e recebe snapshots agregados. A tela
 * busca o relatório salvo após o evento final, em vez de receber métricas e
 * amostras no channel. */
export function useLoadFlowRun(rootPath: string, flowId: string, onFinished?: () => void) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [isRunning, setIsRunning] = useState(false)
  const [progress, setProgress] = useState<LoadRunProgressState>(INITIAL_PROGRESS)
  const [detail, setDetail] = useState<LoadRunDetailDto | null>(null)
  const runIdRef = useRef<string | null>(null)

  const start = useCallback(() => {
    if (isRunning) return
    const loadRunId = crypto.randomUUID()
    runIdRef.current = loadRunId
    setProgress(INITIAL_PROGRESS)
    setDetail(null)
    setIsRunning(true)

    void executeLoadFlow({ loadRunId, rootPath, flowId }, (event: LoadRunEventDto) => {
      if (event.type === 'progress') {
        setProgress(event)
        return
      }
      if (event.type !== 'runFinished') return
      setProgress((current) => ({
        ...current,
        completedIterations: event.completedIterations,
        droppedIterations: event.droppedIterations,
        requests: event.requests,
        failedRequests: event.failedRequests,
        checksPassed: event.checksPassed,
        checksFailed: event.checksFailed,
        activeVus: 0,
      }))
      setIsRunning(false)
      onFinished?.()
      void getLoadRunHistory(rootPath, loadRunId).then((result) => {
        if (result.ok) {
          setDetail(result.value)
        } else {
          showToast(t('flows.loadRun.resultLoadError'), 'error')
        }
      })
    }).then((result) => {
      if (result.ok) return
      setIsRunning(false)
      const message = result.error.kind === 'invalid' || result.error.kind === 'storage' ? result.error.message : t('flows.loadRun.notFound')
      showToast(t('flows.canvas.runErrorToast', { message }), 'error')
    })
  }, [flowId, isRunning, onFinished, rootPath, showToast, t])

  const cancel = useCallback(() => {
    if (runIdRef.current !== null) void cancelLoadFlow(runIdRef.current)
  }, [])

  return { isRunning, progress, detail, setDetail, start, cancel }
}
