import { GrpcResponseView } from './GrpcResponseView'
import type { GrpcStreamState } from '../grpc-stream'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { ResponseBodyOutput } from '../../../bindings/execute-graphql-request'
import type { RequestSendDto, RequestSendsSource } from '../../../bindings/list-request-sends'
import type { ValueMonitorDto } from '../../../bindings/list-value-monitors'
import { readResponseBodyChunk } from '../../../bindings/read-response-body-chunk'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { CopyIcon, MonitorIcon, PanelBottomIcon, PanelRightIcon, Spinner, TrashIcon } from '../../../shared/ui/icons'
import { IconButton } from '../../../shared/ui/IconButton'
import { LoadingBar } from '../../../shared/ui/LoadingBar'
import { Tooltip } from '../../../shared/ui/Tooltip'
import { useToast } from '../../../shared/ui/use-toast'
import { graphqlErrorsOf, grpcResultOf, httpResultOf } from '../request-workbench.types'
import { describeError, errorDetail, errorLabel, formatSize, statusTone } from '../response-summary'
import type { ExecutionState, ResponseTabId } from '../request-workbench.types'
import { Tabs } from '../../../shared/ui/Tabs'
import type { JsonPathSegment } from '../json-value-index'
import { orderPair } from '../send-history'
import { usePastSend, useRequestSends } from '../use-send-history'
import { ResponseBody, type ResponseBodyMonitor } from './ResponseBody'
import { ElapsedTimer } from './ElapsedTimer'
import { FailureMessage } from './FailureMessage'
import { ResponseErrorsList } from './ResponseErrorsList'
import { ResponseHeadersList } from './ResponseHeadersList'
import { ScriptTestList } from './ScriptTestList'
import { ResponseComparisonView } from './ResponseComparisonView'
import { ResponseHistoryMenu, type ResponseView } from './ResponseHistoryMenu'
import { ResponseNetworkBadge } from './ResponseNetworkBadge'
import { registerEditorRevealer } from '../editor-bridge'

/** Collect the body, fetching windowed chunks on demand, for copying as one string. */
async function collectBodyText(body: ResponseBodyOutput): Promise<string> {
  if (body.kind === 'inline') return body.body

  let text = body.preview
  let offset = body.previewNextOffset
  while (offset !== null) {
    const result = await readResponseBodyChunk({ handle: body.handle, offset })
    if (!result.ok) break
    text += result.value.chunk
    offset = result.value.nextOffset
  }
  return text
}

export type ResponsePanelLayout = 'bottom' | 'right'

interface ResponsePanelProps {
  execution: ExecutionState
  grpcStream?: GrpcStreamState
  onClear: () => void
  layout: ResponsePanelLayout
  onToggleLayout: () => void
  layoutToggleDisabled?: boolean
  /** Capture a JSON body value for the request post-response script. */
  onCaptureValue?: (path: JsonPathSegment[]) => void
  /** Resend without the response size limit, offered after exceeding it. */
  onResendWithoutLimit?: () => void
  /** Request or tab whose sends populate the optional History menu. */
  sendsSource?: RequestSendsSource
  /** Send that produced the displayed response, shown as Current in history. */
  currentSendId?: string | null
  /** Optional value monitor control shared across requests. */
  monitor?: ResponseMonitorControl
  /** Open Save responses settings when history did not retain the displayed body. */
  onOpenHistorySettings?: () => void
}

export interface ResponseMonitorControl {
  monitors: ValueMonitorDto[]
  enabled: boolean
  onToggle: () => void
}

const RESPONSE_TABS: { id: ResponseTabId; label: string }[] = [
  { id: 'body', label: 'Body' },
  { id: 'headers', label: 'Headers' },
  { id: 'errors', label: 'Errors' },
  { id: 'tests', label: 'Tests' },
]

const CURRENT_VIEW: ResponseView = { kind: 'current' }

/** gRPC messages are shown as JSON (spec 0129). */
const GRPC_BODY_HEADERS = [{ name: 'content-type', value: 'application/json' }]
const NO_SOURCE: RequestSendsSource = { rootPath: '', requestId: null, tabId: null }

export const ResponsePanel = memo(function ResponsePanel({
  execution,
  grpcStream,
  onClear,
  layout,
  onToggleLayout,
  layoutToggleDisabled = false,
  onCaptureValue,
  onResendWithoutLimit,
  sendsSource,
  currentSendId = null,
  monitor,
  onOpenHistorySettings,
}: ResponsePanelProps) {
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const [responseTab, setResponseTab] = useState<ResponseTabId>('body')
  // The agent highlights inside the body view, so it can ask for it.
  useEffect(() => registerEditorRevealer('response', () => setResponseTab('body')), [])

  // Load send history only after its menu opens.
  const [historyActivated, setHistoryActivated] = useState(false)
  const sends = useRequestSends(sendsSource ?? NO_SOURCE, currentSendId, historyActivated && sendsSource !== undefined)
  // A selected view belongs to its tab and send; changing either restores
  // the current response view.
  const viewKey = `${sendsSource?.tabId ?? ''}\n${currentSendId ?? ''}`
  const [viewState, setViewState] = useState<{ key: string; view: ResponseView }>({ key: viewKey, view: CURRENT_VIEW })
  const view = viewState.key === viewKey && execution.status !== 'loading' ? viewState.view : CURRENT_VIEW
  const setView = useCallback((next: ResponseView) => setViewState({ key: viewKey, view: next }), [viewKey])

  const past = usePastSend(sendsSource?.rootPath ?? '', view.kind === 'past' ? view.sendId : null)
  // Null while a selected past send loads or fails to load.
  const displayed: ExecutionState | null = view.kind === 'past' ? (past?.status === 'ready' ? past.execution : null) : execution

  const sendList = sends.state.status === 'ready' ? sends.state.sends : []
  const findSend = (id: string) => sendList.find((send) => send.id === id) ?? null
  const viewedPast = view.kind === 'past' ? findSend(view.sendId) : null
  const comparePair = (() => {
    if (view.kind !== 'compare') return null
    const first = findSend(view.firstId)
    const second = findSend(view.secondId)
    return first && second ? orderPair(first, second) : null
  })()

  const timeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(language, {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    [language],
  )
  const formatTime = useCallback((send: RequestSendDto) => timeFormatter.format(new Date(send.executedAtMs)), [timeFormatter])

  const success = displayed?.status === 'success' ? displayed : null
  // Keep tabs visible for history entries without a stored response body.
  const notStored = success?.responseNotStored === true
  // Without the body, GraphQL errors are unknown.
  const graphqlErrors = success && !notStored ? graphqlErrorsOf(success.result) : null
  const hasGraphqlErrors = !!graphqlErrors && graphqlErrors.length > 0
  const http = success ? httpResultOf(success.result) : null
  const grpc = grpcResultOf(success?.result)
  // Older restored executions may omit testResults.
  const testResults = success ? (success.result.testResults ?? []) : []
  const hasTests = testResults.length > 0
  const failedTests = testResults.filter((test) => !test.passed).length
  const tabs = RESPONSE_TABS.filter(
    (tab) => (tab.id !== 'errors' || graphqlErrors !== null) && (tab.id !== 'tests' || hasTests),
  )
  const visibleTab = tabs.some((tab) => tab.id === responseTab) ? responseTab : 'body'

  // Enable value monitoring only when a monitor has enabled fields.
  const hasMonitors = monitor?.monitors.some((item) => item.enabled && item.fields.length > 0) ?? false
  const monitorOn = !!monitor?.enabled && hasMonitors
  const [monitorFailed, setMonitorFailed] = useState<number | null>(null)
  const monitorMonitors = monitor?.monitors
  const bodyMonitor = useMemo<ResponseBodyMonitor | null>(
    () => (monitorOn && monitorMonitors ? { monitors: monitorMonitors, onFailedCount: setMonitorFailed } : null),
    [monitorOn, monitorMonitors],
  )
  const failedBadge = monitorOn && view.kind !== 'compare' && success && monitorFailed !== null && monitorFailed > 0 ? monitorFailed : null

  const handleCopy = useCallback(async () => {
    if (!success || notStored) return
    const text = await collectBodyText(success.result.body)
    try {
      await navigator.clipboard.writeText(text)
      showToast(t('toasts.responseCopied'))
    } catch {
      // Clipboard unavailable: do not show a success toast.
    }
  }, [success, notStored, showToast, t])

  const handleClear = useCallback(() => {
    setView(CURRENT_VIEW)
    onClear()
  }, [onClear, setView])

  return (
    <section className="rw-response" aria-live="polite" aria-label={t('response.sectionLabel')}>
      <div className="rw-response-toolbar">
        <div className="rw-response-toolbar-start">
          {sendsSource && (
            <ResponseHistoryMenu
              sends={sends.state}
              currentSendId={currentSendId}
              view={view}
              onOpen={() => {
                if (historyActivated) sends.reload()
                else setHistoryActivated(true)
              }}
              onShowCurrent={() => setView(CURRENT_VIEW)}
              onShowPast={(sendId) => setView({ kind: 'past', sendId })}
              onCompare={(firstId, secondId) => setView({ kind: 'compare', firstId, secondId })}
              onChangeBaseline={(sendId) => {
                void sends.changeBaseline(sendId).then((ok) => {
                  if (!ok) showToast(t('responseHistory.baselineError'), 'error')
                })
              }}
              formatTime={formatTime}
            />
          )}
          {monitor && (
            <Tooltip
              label={!hasMonitors ? t('monitor.noMonitors') : monitorOn ? t('monitor.toggleOnAria') : t('monitor.toggleOffAria')}
              className="rw-monitor-toggle-host"
            >
              <button type="button" className="rw-monitor-toggle" aria-pressed={monitorOn} disabled={!hasMonitors} onClick={monitor.onToggle}>
                <MonitorIcon size={14} />
                {t('monitor.toggle')}
                {failedBadge !== null && (
                  <span className="rw-monitor-toggle-count">
                    <span aria-hidden="true">{failedBadge}</span>
                    <span className="rw-visually-hidden">{t('monitor.failedAria', { count: failedBadge })}</span>
                  </span>
                )}
              </button>
            </Tooltip>
          )}
          {view.kind !== 'compare' && grpc && (
            <span className="rw-response-summary">
              <span className={`rw-response-status rw-response-status--${grpc.status.code === 0 ? 'success' : 'error'}`}>
                gRPC {grpc.status.codeName}
              </span>
              <span className="rw-response-metric">{grpc.durationMs} ms</span>
              <span className="rw-response-metric">{formatSize(grpc.sizeBytes)}</span>
              <span className="rw-response-metric">{t('response.grpcMessageCount', { count: grpc.messageCount })}</span>
            </span>
          )}
          {view.kind !== 'compare' && displayed?.status === 'success' && http && (
            <span className="rw-response-summary">
              {/* History sends do not retain connection details, including the HTTP version. */}
              {http.connection.httpVersion !== '' && <ResponseNetworkBadge connection={http.connection} />}
              <span className={`rw-response-status rw-response-status--${statusTone(http.statusCode)}`}>
                HTTP {http.statusCode}
              </span>
              {graphqlErrors !== null && (
                <span className={`rw-response-status rw-response-status--${hasGraphqlErrors ? 'error' : 'success'}`}>
                  {hasGraphqlErrors ? 'GraphQL: Error' : 'GraphQL: Success'}
                </span>
              )}
              <span className="rw-response-metric">{http.durationMs} ms</span>
              <span className="rw-response-metric">{formatSize(http.sizeBytes)}</span>
            </span>
          )}
          {view.kind !== 'compare' && displayed?.status === 'error' && (
            <span className="rw-response-summary rw-response-summary--error">{errorLabel(t, displayed.error)}</span>
          )}
          {displayed?.status === 'loading' && (
            <span className="rw-response-summary">
              <Spinner size={12} />
              {t('response.sending')}
              <ElapsedTimer startedAt={displayed.startedAt} label={t('response.elapsedAria')} />
            </span>
          )}
        </div>
        <div className="rw-response-toolbar-actions">
          <IconButton
            icon={<CopyIcon size={14} />}
            label={t('response.copyAria')}
            onClick={() => void handleCopy()}
            disabled={view.kind === 'compare' || !success || notStored}
          />
          <IconButton
            icon={<TrashIcon size={14} />}
            label={t('response.clearAria')}
            onClick={handleClear}
            disabled={execution.status === 'idle' && view.kind === 'current'}
          />
          <IconButton
            icon={layout === 'bottom' ? <PanelRightIcon size={14} /> : <PanelBottomIcon size={14} />}
            label={layout === 'bottom' ? t('response.layoutToggle.moveRightAria') : t('response.layoutToggle.moveBottomAria')}
            onClick={onToggleLayout}
            disabled={layoutToggleDisabled}
          />
        </div>
      </div>

      {execution.status === 'loading' && <LoadingBar />}

      {view.kind === 'past' && (
        <div className="rw-history-banner" role="status">
          <span>{viewedPast ? t('responseHistory.viewingPast', { time: formatTime(viewedPast) }) : t('responseHistory.viewingPastUnknown')}</span>
          <button type="button" className="rw-link-button" onClick={() => setView(CURRENT_VIEW)}>
            {t('responseHistory.backToCurrent')}
          </button>
          {currentSendId !== null && findSend(currentSendId) && (
            <button type="button" className="rw-link-button" onClick={() => setView({ kind: 'compare', firstId: view.sendId, secondId: currentSendId })}>
              {t('responseHistory.compareWithCurrent')}
            </button>
          )}
        </div>
      )}

      {/* Remount content on view/state changes to trigger its entrance animation. */}
      <div key={`${view.kind}-${grpcStream ? 'grpc' : displayed?.status ?? 'pending'}`} className="rw-response-content">
        {view.kind === 'compare' ? (
          <div className="rw-response-body">
            {comparePair && sendsSource ? (
              <ResponseComparisonView
                rootPath={sendsSource.rootPath}
                base={comparePair.base}
                target={comparePair.target}
                onClose={() => setView(CURRENT_VIEW)}
                formatTime={formatTime}
              />
            ) : (
              <p className="rw-status-message">{t('responseHistory.loading')}</p>
            )}
          </div>
        ) : view.kind === 'current' && grpcStream && !notStored ? (
          <GrpcResponseView key={viewKey} stream={grpcStream} result={grpc}
            error={displayed?.status === 'error' ? describeError(t, displayed.error) : undefined}
            onCaptureValue={onCaptureValue} monitor={bodyMonitor} />
        ) : success ? (
        <>
          <Tabs
            tabs={tabs.map((tab) => {
              if (tab.id === 'headers' && grpc) return { ...tab, label: 'Metadata' }
              if (tab.id === 'errors' && graphqlErrors) return { ...tab, badge: graphqlErrors.length }
              if (tab.id === 'tests') {
                return {
                  ...tab,
                  label: (
                    <>
                      {tab.label}
                      <span className={`rw-response-tests-count rw-response-tests-count--${failedTests > 0 ? 'error' : 'success'}`}>
                        {testResults.length - failedTests}/{testResults.length}
                      </span>
                    </>
                  ),
                }
              }
              return tab
            })}
            activeTab={visibleTab}
            onChange={setResponseTab}
            ariaLabel={t('response.tabsLabel')}
            idPrefix="response-"
          />
          {/* Keep response tabs mounted with hidden so expensive formatting, tokenization and loaded windowed chunks survive tab switches. */}
          <div
            className="rw-response-body ui-tabpanel-motion"
            role="tabpanel"
            id="tabpanel-response-body"
            aria-labelledby="tab-response-body"
            hidden={visibleTab !== 'body'}
          >
            {notStored ? (
              <ResponseNotStored onChangeSetting={onOpenHistorySettings} />
            ) : grpc && grpc.status.code !== 0 && grpc.messageCount === 0 ? (
              <FailureMessage
                className="rw-response-failure"
                summary={`${grpc.status.codeName}${grpc.status.message ? `: ${grpc.status.message}` : ''}`}
                detail={null}
              />
            ) : (
              <ResponseBody
                // Formatting and loaded text belong to the displayed response; another
                // tab or send starts fresh.
                key={`${viewKey}\n${view.kind}\n${success.result.body.kind === 'windowed' ? success.result.body.handle : ''}`}
                body={success.result.body}
                bodyEncoding={http ? http.bodyEncoding : 'text'}
                headers={http ? http.headers : GRPC_BODY_HEADERS}
                onCaptureValue={view.kind === 'current' ? onCaptureValue : undefined}
                monitor={bodyMonitor}
                agentSlot={view.kind === 'current' ? 'response' : undefined}
              />
            )}
          </div>
          <div
            className="rw-response-body ui-tabpanel-motion"
            role="tabpanel"
            id="tabpanel-response-headers"
            aria-labelledby="tab-response-headers"
            hidden={visibleTab !== 'headers'}
          >
            {notStored ? (
              <ResponseNotStored onChangeSetting={onOpenHistorySettings} />
            ) : (
              <ResponseHeadersList headers={grpc ? [...grpc.headers, ...grpc.trailers] : success.result.headers} />
            )}
          </div>
          {graphqlErrors !== null && (
            <div
              className="rw-response-body ui-tabpanel-motion"
              role="tabpanel"
              id="tabpanel-response-errors"
              aria-labelledby="tab-response-errors"
              hidden={visibleTab !== 'errors'}
            >
              <ResponseErrorsList errors={graphqlErrors} />
            </div>
          )}
          {hasTests && (
            <div
              className="rw-response-body ui-tabpanel-motion"
              role="tabpanel"
              id="tabpanel-response-tests"
              aria-labelledby="tab-response-tests"
              hidden={visibleTab !== 'tests'}
            >
              <ScriptTestList tests={testResults} />
            </div>
          )}
        </>
        ) : (
          <div className="rw-response-body rw-response-body--placeholder">
            {displayed === null && past?.status === 'loading' && <p className="rw-status-message">{t('responseHistory.loadingPast')}</p>}
            {displayed === null && past?.status === 'error' && <p className="rw-status-message">{t('responseHistory.loadPastError')}</p>}
            {displayed?.status === 'idle' && <p className="rw-status-message">{t('response.none')}</p>}
            {displayed?.status === 'loading' && <p className="rw-status-message">{t('response.loadingBody')}</p>}
            {displayed?.status === 'error' && (
              <FailureMessage
                className="rw-response-failure"
                summary={describeError(t, displayed.error)}
                detail={errorDetail(displayed.error)}
              />
            )}
            {displayed?.status === 'error' &&
              displayed.error.kind === 'responseTooLarge' &&
              view.kind === 'current' &&
              onResendWithoutLimit && (
                <Button variant="ghost" onClick={onResendWithoutLimit}>
                  {t('response.resendWithoutLimit')}
                </Button>
              )}
          </div>
        )}
      </div>
    </section>
  )
})

/** Notice for a history send that retained only status, duration and size. */
function ResponseNotStored({ onChangeSetting }: { onChangeSetting?: () => void }) {
  const { t } = useLanguage()
  return (
    <div className="rw-response-not-stored">
      <p className="rw-status-message">{t('response.notStored')}</p>
      {onChangeSetting && (
        <button type="button" className="rw-link-button" onClick={onChangeSetting}>
          {t('response.notStoredChangeSetting')}
        </button>
      )}
    </div>
  )
}
