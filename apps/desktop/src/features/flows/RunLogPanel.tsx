import { useEffect, useState } from 'react'
import { getFlowNodeOutput } from '../../bindings/get-flow-node-output'
import type { FlowNodeOutputDto } from '../../bindings/get-flow-node-output'
import { useLanguage } from '../../shared/i18n/use-language'
import type { TranslationKey, TranslationParams } from '../../shared/i18n/translations'
import { Badge } from '../../shared/ui/Badge'
import { IconButton } from '../../shared/ui/IconButton'
import { AlertIcon, CheckIcon, ClockIcon, CloseIcon, CopyIcon, Spinner } from '../../shared/ui/icons'
import { useToast } from '../../shared/ui/use-toast'
import { UrlPreview } from './UrlPreview'
import { OutputTree } from './OutputTree'
import { outputRoots, parseBody, referenceFor } from './output-tree'
import { entryDurationMs } from './run-log'
import type { RunLogEntry } from './run-log'
import './run-log-panel.css'

/** O que o log precisa saber de um node para nomeá-lo, já resolvido pelo canvas. */
export interface RunLogNodeInfo {
  label: string
  kindLabel: string
  /** `MÉTODO url` — só para nodes de requisição. */
  request?: string
  /** Bloco "Aguardar chamada": a chamada recebida fica como output do node. */
  capturesRequest?: boolean
}

interface RunLogPanelProps {
  entries: RunLogEntry[]
  nodeInfo: Record<string, RunLogNodeInfo>
  runStartedAtMs: number | null
  flowExecutionId: string | null
  isRunning: boolean
  /** Sem `onClose` o painel não tem botão de fechar (run log de um snapshot). */
  onClose?: () => void
  /** Saídas já carregadas por node (run do histórico); sem isso, buscam-se
   * sob demanda no backend, do último run ao vivo. */
  outputs?: Record<string, FlowNodeOutputDto>
}

type Tone = 'success' | 'error' | 'muted' | 'running'

function toneOf(entry: RunLogEntry): Tone {
  const { status } = entry
  if (status.status === 'running') return 'running'
  if (status.status === 'failed') return 'error'
  if (status.status === 'success') return status.statusCode >= 400 ? 'error' : 'success'
  // Cada iteração de um `while` é uma linha já fechada (o corpo vem logo abaixo).
  if (
    status.status === 'branched' ||
    status.status === 'completed' ||
    status.status === 'looping' ||
    status.status === 'loopFinished'
  ) {
    return 'success'
  }
  if (status.status === 'skipped' && status.reason === 'notRunnable') return 'success'
  return 'muted'
}

function statusLabel(entry: RunLogEntry, t: (key: TranslationKey, params?: TranslationParams) => string): string {
  const { status } = entry
  if (status.status === 'looping') return t('flows.canvas.whileIterationLabel', { iteration: String(status.iteration) })
  if (status.status === 'loopFinished') return t('flows.canvas.whileFinishedLabel', { iterations: String(status.iterations) })
  const key = statusLabelKey(entry)
  return key ? t(key) : ''
}

function statusLabelKey(entry: RunLogEntry): TranslationKey | null {
  const { status } = entry
  if (status.status === 'running') return 'flows.runLog.statusRunning'
  if (status.status === 'failed') return 'flows.canvas.nodeFailedLabel'
  if (status.status === 'cancelled') return 'flows.canvas.nodeCancelledLabel'
  if (status.status === 'completed') return 'flows.runLog.statusCompleted'
  if (status.status === 'branched') return status.result ? 'flows.canvas.ifTrueLabel' : 'flows.canvas.ifFalseLabel'
  if (status.status === 'skipped') {
    if (status.reason === 'notRunnable') return 'flows.runLog.statusCompleted'
    if (status.reason === 'branchNotTaken') return 'flows.canvas.nodeBranchNotTakenLabel'
    if (status.reason === 'loopInterrupted') return 'flows.canvas.nodeLoopInterruptedLabel'
    if (status.reason === 'cancelled') return 'flows.canvas.nodeCancelledLabel'
    return 'flows.canvas.nodeSkippedLabel'
  }
  return null
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString()
}

function formatDuration(ms: number | null): string {
  return ms === null ? '—' : `${ms} ms`
}

function StatusIcon({ tone }: { tone: Tone }) {
  if (tone === 'running') return <Spinner size={13} />
  if (tone === 'error') return <AlertIcon size={13} />
  if (tone === 'success') return <CheckIcon size={13} />
  return <ClockIcon size={13} />
}

/** Log do último Run do flow (painel inferior do canvas): uma linha por node na
 * ordem em que o run o alcançou, com detalhe resumido ao selecionar. Só mostra
 * o que os eventos do motor já carregam — nada de corpo de resposta. Montar
 * com `key` do run para a seleção zerar a cada execução. */
export function RunLogPanel({ entries, nodeInfo, runStartedAtMs, flowExecutionId, isRunning, onClose, outputs }: RunLogPanelProps) {
  const { t } = useLanguage()
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const selected = selectedIndex === null ? null : (entries[selectedIndex] ?? null)

  const infoFor = (nodeId: string): RunLogNodeInfo => nodeInfo[nodeId] ?? { label: nodeId.slice(0, 8), kindLabel: '' }

  return (
    <section className="flow-run-log" aria-label={t('flows.runLog.title')}>
      <header className="flow-run-log-header">
        <h3>{t('flows.runLog.title')}</h3>
        {runStartedAtMs !== null && <span className="flow-run-log-time">{formatTime(runStartedAtMs)}</span>}
        <Badge tone={isRunning ? 'accent' : 'neutral'}>
          {isRunning ? t('flows.runLog.runInProgress') : t('flows.runLog.runFinished')}
        </Badge>
        <span className="flow-run-log-spacer" />
        {onClose && <IconButton icon={<CloseIcon size={12} />} label={t('flows.runLog.closeAria')} onClick={onClose} />}
      </header>

      <div className="flow-run-log-body">
        <ul className="flow-run-log-list">
          {entries.length === 0 && <li className="flow-run-log-empty">{t('flows.runLog.empty')}</li>}
          {entries.map((entry, index) => {
            const tone = toneOf(entry)
            const info = infoFor(entry.nodeId)
            return (
              <li key={`${entry.nodeId}-${index}`}>
                <button
                  type="button"
                  className={`flow-run-log-row flow-run-log-row--${tone}${index === selectedIndex ? ' flow-run-log-row--selected' : ''}`}
                  aria-pressed={index === selectedIndex}
                  onClick={() => setSelectedIndex(index)}
                >
                  <span className={`flow-run-log-icon flow-run-log-icon--${tone}`}>
                    <StatusIcon tone={tone} />
                  </span>
                  <span className="flow-run-log-name">{info.label}</span>
                  <span className="flow-run-log-meta">
                    {formatTime(entry.startedAtMs)} • {formatDuration(entryDurationMs(entry))}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>

        <div className="flow-run-log-detail">
          {selected ? <EntryDetail entry={selected} info={infoFor(selected.nodeId)} flowExecutionId={flowExecutionId} outputs={outputs} /> : <p className="flow-run-log-empty">{t('flows.runLog.selectHint')}</p>}
        </div>
      </div>
    </section>
  )
}

function EntryDetail({
  entry,
  info,
  flowExecutionId,
  outputs,
}: {
  entry: RunLogEntry
  info: RunLogNodeInfo
  flowExecutionId: string | null
  outputs?: Record<string, FlowNodeOutputDto>
}) {
  const { t } = useLanguage()
  const tone = toneOf(entry)
  const { status } = entry
  const hasOutput = status.status === 'success' || (info.capturesRequest === true && status.status === 'branched' && status.result)

  return (
    <dl className="flow-run-log-fields">
      <div className="flow-run-log-title">
        <strong>{info.label}</strong>
        {info.kindLabel && <span className="flow-run-log-kind">{info.kindLabel}</span>}
      </div>

      <dt>{t('flows.runLog.fieldStatus')}</dt>
      <dd>
        <Badge tone={tone === 'success' ? 'success' : tone === 'error' ? 'error' : tone === 'running' ? 'accent' : 'neutral'}>
          {statusLabel(entry, t)}
        </Badge>
      </dd>

      {status.status === 'success' && (
        <>
          <dt>{t('flows.runLog.fieldHttpStatus')}</dt>
          <dd>{status.statusCode}</dd>
        </>
      )}
      {info.request && (
        <>
          <dt>{t('flows.runLog.fieldRequest')}</dt>
          <dd className="flow-run-log-mono">{info.request}</dd>
        </>
      )}
      {entry.call && (
        <>
          <dt>{t('flows.runLog.fieldUrlTemplate')}</dt>
          <dd className="flow-run-log-mono">
            <UrlPreview
              template={entry.call.requestUrl}
              describe={(name) => {
                const used = entry.call?.variables.find((variable) => variable.name === name)
                return used ? `${name} = ${used.value || t('common.empty')}` : name
              }}
            />
          </dd>
          <dt>{t('flows.runLog.fieldUrlCalled')}</dt>
          <dd className="flow-run-log-mono">{entry.call.resolvedUrl}</dd>
        </>
      )}
      <dt>{t('flows.runLog.fieldStarted')}</dt>
      <dd>{formatTime(entry.startedAtMs)}</dd>
      <dt>{t('flows.runLog.fieldDuration')}</dt>
      <dd>{formatDuration(entryDurationMs(entry))}</dd>
      {status.status === 'failed' && (
        <>
          <dt>{t('flows.runLog.fieldMessage')}</dt>
          <dd className="flow-run-log-mono">{status.message}</dd>
        </>
      )}
      {status.status === 'branched' && status.message && (
        <>
          <dt>{t('flows.runLog.fieldMessage')}</dt>
          <dd className="flow-run-log-mono flow-run-log-message">{status.message}</dd>
        </>
      )}
      {status.status === 'completed' && status.message !== null && (
        <>
          <dt>{t('flows.runLog.fieldMessage')}</dt>
          <dd className="flow-run-log-mono flow-run-log-message">{status.message || t('common.empty')}</dd>
        </>
      )}
      {hasOutput && outputs && (
        // Run reaberto do histórico: um node sem output é uma resposta que não foi guardada.
        <NodeOutputBody
          key={entry.nodeId}
          nodeId={entry.nodeId}
          state={{ status: 'ready', output: outputs[entry.nodeId] ?? null }}
          unavailableMessage={t('flows.runLog.outputNotStored')}
        />
      )}
      {hasOutput && !outputs && flowExecutionId && (
        <NodeOutput key={`${flowExecutionId}-${entry.nodeId}`} flowExecutionId={flowExecutionId} nodeId={entry.nodeId} />
      )}
    </dl>
  )
}

type OutputState = { key: string; output: FlowNodeOutputDto | null; failed: boolean }

/** Output do node, buscado só quando ele é selecionado (nunca vem no evento
 * de progresso). O backend guarda apenas o começo do corpo do último run. */
function NodeOutput({ flowExecutionId, nodeId }: { flowExecutionId: string; nodeId: string }) {
  const key = `${flowExecutionId}:${nodeId}`
  const [state, setState] = useState<OutputState | null>(null)

  useEffect(() => {
    let cancelled = false
    getFlowNodeOutput(flowExecutionId, nodeId)
      .then((output) => {
        if (!cancelled) setState({ key, output, failed: false })
      })
      .catch(() => {
        if (!cancelled) setState({ key, output: null, failed: true })
      })
    return () => {
      cancelled = true
    }
  }, [flowExecutionId, nodeId, key])

  const current = state?.key === key ? state : null
  const bodyState: OutputBodyState = !current
    ? { status: 'loading' }
    : current.failed
      ? { status: 'error' }
      : { status: 'ready', output: current.output }

  return <NodeOutputBody nodeId={nodeId} state={bodyState} />
}

type OutputBodyState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; output: FlowNodeOutputDto | null }

function NodeOutputBody({
  nodeId,
  state,
  unavailableMessage,
}: {
  nodeId: string
  state: OutputBodyState
  /** Texto quando não há output; o padrão explica que só o último run é mantido. */
  unavailableMessage?: string
}) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const output = state.status === 'ready' ? state.output : null
  const scope = output?.request ? 'request' : 'response'

  const copyReference = async (path: string) => {
    try {
      await navigator.clipboard.writeText(referenceFor(nodeId, path, scope))
      showToast(t('toasts.nodeReferenceCopied'))
    } catch {
      // Clipboard indisponível — a referência segue visível para copiar à mão.
    }
  }

  return (
    <div className="flow-run-log-output">
      <dt>{t('flows.runLog.fieldOutput')}</dt>
      <dd>
        {state.status === 'loading' && <span className="flow-run-log-muted">{t('flows.runLog.outputLoading')}</span>}
        {state.status === 'error' && <span className="flow-run-log-muted">{t('flows.runLog.outputError')}</span>}
        {state.status === 'ready' && !output && (
          <span className="flow-run-log-muted">{unavailableMessage ?? t('flows.runLog.outputUnavailable')}</span>
        )}
        {output && (
          <>
            {output.bodyEncoding === 'base64' && (
              <span className="flow-run-log-muted">{t('flows.runLog.outputBinary', { size: String(output.sizeBytes) })}</span>
            )}
            <OutputTree roots={outputRoots(output)} selectedPath={selectedPath} onSelect={setSelectedPath} />
            {selectedPath !== null && (
              <div className="flow-output-reference">
                <code>{referenceFor(nodeId, selectedPath, scope)}</code>
                <IconButton icon={<CopyIcon size={11} />} label={t('flows.runLog.outputCopyReference')} onClick={() => void copyReference(selectedPath)} />
              </div>
            )}
            {parseBody(output) === undefined && output.bodyEncoding !== 'base64' && (
              <pre className="flow-run-log-body-text">{output.body || t('flows.runLog.outputEmpty')}</pre>
            )}
            {output.truncated && output.bodyEncoding !== 'base64' && (
              <span className="flow-run-log-muted">{t('flows.runLog.outputTruncated', { size: String(output.sizeBytes) })}</span>
            )}
          </>
        )}
      </dd>
    </div>
  )
}
