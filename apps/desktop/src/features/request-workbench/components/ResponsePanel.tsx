import { memo, useCallback, useMemo, useState } from 'react'
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
import { graphqlErrorsOf } from '../request-workbench.types'
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

/** Junta todo o corpo (inclusive o restante de um corpo `windowed`, buscado sob demanda) para copiar como texto único. */
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
  onClear: () => void
  layout: ResponsePanelLayout
  onToggleLayout: () => void
  layoutToggleDisabled?: boolean
  /** Captura de um valor JSON do corpo para o script de pós-resposta da requisição. */
  onCaptureValue?: (path: JsonPathSegment[]) => void
  /** Reenvia a requisição ignorando o limite de tamanho de resposta (só aparece quando o envio atual passou do limite). */
  onResendWithoutLimit?: () => void
  /** Requisição (ou aba) cujos envios aparecem no botão "Histórico"; sem ela, o botão não existe. */
  sendsSource?: RequestSendsSource
  /** Envio que produziu a resposta exibida — a "Atual" do histórico. */
  currentSendId?: string | null
  /** Monitor de valores (vale para todas as requisições); sem ele, o botão "Monitor" não existe. */
  monitor?: ResponseMonitorControl
  /** Abre a configuração "Salvar respostas", oferecida quando o histórico não guardou a resposta exibida. */
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
const NO_SOURCE: RequestSendsSource = { rootPath: '', requestId: null, tabId: null }

export const ResponsePanel = memo(function ResponsePanel({
  execution,
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

  // Histórico de envios: a lista só é carregada depois que o menu é aberto.
  const [historyActivated, setHistoryActivated] = useState(false)
  const sends = useRequestSends(sendsSource ?? NO_SOURCE, currentSendId, historyActivated && sendsSource !== undefined)
  // A visão escolhida vale para a aba e o envio em que foi escolhida: um novo
  // envio (ou outra aba) volta para a resposta atual.
  const viewKey = `${sendsSource?.tabId ?? ''}\n${currentSendId ?? ''}`
  const [viewState, setViewState] = useState<{ key: string; view: ResponseView }>({ key: viewKey, view: CURRENT_VIEW })
  const view = viewState.key === viewKey && execution.status !== 'loading' ? viewState.view : CURRENT_VIEW
  const setView = useCallback((next: ResponseView) => setViewState({ key: viewKey, view: next }), [viewKey])

  const past = usePastSend(sendsSource?.rootPath ?? '', view.kind === 'past' ? view.sendId : null)
  // `null` enquanto o envio anterior escolhido carrega (ou falha ao carregar).
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
  // Envio do histórico sem resposta guardada: as abas continuam, com o aviso no lugar do conteúdo.
  const notStored = success?.responseNotStored === true
  // Sem o corpo, não dá para saber se houve erros GraphQL.
  const graphqlErrors = success && !notStored ? graphqlErrorsOf(success.result) : null
  const hasGraphqlErrors = !!graphqlErrors && graphqlErrors.length > 0
  // `testResults` pode faltar em execuções restauradas de formatos antigos.
  const testResults = success ? (success.result.testResults ?? []) : []
  const hasTests = testResults.length > 0
  const failedTests = testResults.filter((test) => !test.passed).length
  const tabs = RESPONSE_TABS.filter(
    (tab) => (tab.id !== 'errors' || graphqlErrors !== null) && (tab.id !== 'tests' || hasTests),
  )
  const visibleTab = tabs.some((tab) => tab.id === responseTab) ? responseTab : 'body'

  // Monitor de valores: só ligado de fato quando há algum monitor habilitado com campos.
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
      // Clipboard indisponível (permissão negada, contexto não seguro) — sem toast de sucesso.
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
          {view.kind !== 'compare' && displayed?.status === 'success' && (
            <span className="rw-response-summary">
              {/* Sends do histórico não guardam a conexão (versão HTTP vazia). */}
              {displayed.result.connection.httpVersion !== '' && <ResponseNetworkBadge connection={displayed.result.connection} />}
              <span className={`rw-response-status rw-response-status--${statusTone(displayed.result.statusCode)}`}>
                HTTP {displayed.result.statusCode}
              </span>
              {graphqlErrors !== null && (
                <span className={`rw-response-status rw-response-status--${hasGraphqlErrors ? 'error' : 'success'}`}>
                  {hasGraphqlErrors ? 'GraphQL: Error' : 'GraphQL: Success'}
                </span>
              )}
              <span className="rw-response-metric">{displayed.result.durationMs} ms</span>
              <span className="rw-response-metric">{formatSize(displayed.result.sizeBytes)}</span>
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

      {/* A `key` remonta o conteúdo a cada mudança de visão/estado, disparando o fade de entrada. */}
      <div key={`${view.kind}-${displayed?.status ?? 'pending'}`} className="rw-response-content">
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
        ) : success ? (
        <>
          <Tabs
            tabs={tabs.map((tab) => {
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
          {/* As três permanecem montadas (alternando `hidden`) em vez de só
              renderizar a aba ativa: `ResponseBody` reformata/tokeniza corpos
              grandes e mantém estado de chunks carregados (`WindowedBody`) —
              desmontar e remontar a cada troca de aba refazia esse trabalho e
              travava o editor ao voltar para "Body". */}
          <div
            className="rw-response-body ui-tabpanel-motion"
            role="tabpanel"
            id="tabpanel-response-body"
            aria-labelledby="tab-response-body"
            hidden={visibleTab !== 'body'}
          >
            {notStored ? (
              <ResponseNotStored onChangeSetting={onOpenHistorySettings} />
            ) : (
              <ResponseBody
                // Formato escolhido e texto carregado são do corpo exibido: outra
                // aba ou outro envio começa do zero, sem herdar o estado anterior.
                key={`${viewKey}\n${view.kind}\n${success.result.body.kind === 'windowed' ? success.result.body.handle : ''}`}
                body={success.result.body}
                bodyEncoding={success.result.bodyEncoding}
                headers={success.result.headers}
                onCaptureValue={view.kind === 'current' ? onCaptureValue : undefined}
                monitor={bodyMonitor}
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
              <ResponseHeadersList headers={success.result.headers} />
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

/** Aviso de um envio do histórico que guardou só status, tempo e tamanho. */
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
