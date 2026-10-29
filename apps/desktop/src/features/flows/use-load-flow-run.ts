import { useCallback } from 'react'
import { executeLoadFlow } from '../../bindings/execute-load-flow'
import type { LoadRunEventDto } from '../../bindings/execute-load-flow'
import { getLoadRunHistory } from '../../bindings/get-load-run-history'
import { useLanguage } from '../../shared/i18n/use-language'
import { useToast } from '../../shared/ui/use-toast'
import { INITIAL_LOAD_PROGRESS, useLoadFlowRunSession } from './load-flow-run-session'
export type { LoadRunProgressState } from './load-flow-run-session'

/** Load execution belongs to the open flow session, including while its canvas is unmounted. */
export function useLoadFlowRun(rootPath: string, flowId: string, onFinished?: () => void) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const { state, session } = useLoadFlowRunSession(rootPath, flowId)

  const start = useCallback(() => {
    if (session.state.isRunning || session.disposed) return
    const loadRunId = crypto.randomUUID()
    session.update({ runId: loadRunId, progress: INITIAL_LOAD_PROGRESS, detail: null, isRunning: true, error: null })
    void executeLoadFlow({ loadRunId, rootPath, flowId }, (event: LoadRunEventDto) => {
      if (session.disposed || session.state.runId !== loadRunId) return
      if (event.type === 'progress') { session.update({ progress: event }); return }
      if (event.type !== 'runFinished') return
      session.update({ progress: {
        ...session.state.progress, completedIterations: event.completedIterations,
        droppedIterations: event.droppedIterations, requests: event.requests,
        failedRequests: event.failedRequests, checksPassed: event.checksPassed,
        checksFailed: event.checksFailed, activeVus: 0,
      }, isRunning: false })
      onFinished?.()
      void getLoadRunHistory(rootPath, loadRunId).then((result) => {
        if (session.disposed || session.state.runId !== loadRunId) return
        if (result.ok) session.setDetail(result.value)
        else showToast(t('flows.loadRun.resultLoadError'), 'error')
      })
    }).then((result) => {
      if (result.ok || session.disposed || session.state.runId !== loadRunId) return
      const message = result.error.kind === 'invalid' || result.error.kind === 'storage' ? result.error.message : t('flows.loadRun.notFound')
      session.update({ isRunning: false, error: message })
      showToast(t('flows.canvas.runErrorToast', { message }), 'error')
    })
    return loadRunId
  }, [flowId, onFinished, rootPath, showToast, t, session])

  return { ...state, setDetail: session.setDetail, start, cancel: session.cancel }
}
