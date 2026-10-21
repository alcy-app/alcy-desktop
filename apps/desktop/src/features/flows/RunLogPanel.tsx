import { useEffect, useRef, useState } from 'react'
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
import { FlowOutputExplorer } from './FlowOutputExplorer'

/** Canvas-resolved node metadata used to label execution log entries. */
export interface RunLogNodeInfo {
  label: string
  kindLabel: string
  /** METHOD URL for request nodes. */
  request?: string
  /** Wait for call nodes expose the captured request as their output. */
  capturesRequest?: boolean
}

interface RunLogPanelProps {
  rootPath?: string
  onSelectNode?: (nodeId: string) => void
  entries: RunLogEntry[]
  nodeInfo: Record<string, RunLogNodeInfo>
  runStartedAtMs: number | null
  flowExecutionId: string | null
  isRunning: boolean
  /** Historical snapshots omit onClose and cannot close their log panel. */
  onClose?: () => void
  /** Legacy preloaded output previews; otherwise query the latest execution on demand. */
  outputs?: Record<string, FlowNodeOutputDto>
}

type Tone = 'success' | 'error' | 'muted' | 'running'

function toneOf(entry: RunLogEntry): Tone {
  const { status } = entry
  if (status.status === 'running') return 'running'
  if (status.status === 'failed') return 'error'
  if (status.status === 'success') return status.statusCode >= 400 ? 'error' : 'success'
  // Each While iteration has a completed log entry, followed by its body.
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
  if (status.status === 'waitingForHuman') return 'flows.forms.waiting'
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

/** Execution-ordered log entries with selected-node details. Mount with the run key to reset selection for each execution. */
export function RunLogPanel({ entries, nodeInfo, runStartedAtMs, flowExecutionId, isRunning, onClose, outputs, rootPath, onSelectNode }: RunLogPanelProps) {
  const { t } = useLanguage()
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 260 })
  const [rowHeight, setRowHeight] = useState(44)
  const firstRow = useRef<HTMLLIElement | null>(null)
  const start = Math.max(0, Math.floor(viewport.top / rowHeight) - 6)
  const end = Math.min(entries.length, start + Math.ceil(viewport.height / rowHeight) + 12)
  const hasEntries = entries.length > 0
  useEffect(() => {
    if (!firstRow.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.height > 0) setRowHeight(entry.contentRect.height) })
    observer.observe(firstRow.current)
    return () => observer.disconnect()
  }, [start, hasEntries])
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
        <ul className="flow-run-log-list" onScroll={(event) => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight || 260 })}>
          {entries.length === 0 && <li className="flow-run-log-empty">{t('flows.runLog.empty')}</li>}
          {start > 0 && <li role="presentation" style={{ height: start * rowHeight }} />}
          {entries.slice(start, end).map((entry, offset) => {
            const index = start + offset
            const tone = toneOf(entry)
            const info = infoFor(entry.nodeId)
            return (
              <li key={`${entry.nodeId}-${index}`} ref={index === start ? firstRow : undefined} aria-posinset={index + 1} aria-setsize={entries.length}>
                <button
                  type="button"
                  className={`flow-run-log-row flow-run-log-row--${tone}${index === selectedIndex ? ' flow-run-log-row--selected' : ''}`}
                  aria-pressed={index === selectedIndex}
                  onClick={() => { setSelectedIndex(index); onSelectNode?.(entry.nodeId) }}
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
          {end < entries.length && <li role="presentation" style={{ height: (entries.length - end) * rowHeight }} />}
        </ul>

        <div className="flow-run-log-detail">
          {selected ? <EntryDetail entry={selected} info={infoFor(selected.nodeId)} flowExecutionId={flowExecutionId} outputs={outputs} rootPath={onSelectNode ? undefined : rootPath} hideOutput={Boolean(onSelectNode)} /> : <p className="flow-run-log-empty">{t('flows.runLog.selectHint')}</p>}
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
  rootPath,
  hideOutput,
}: {
  entry: RunLogEntry
  info: RunLogNodeInfo
  flowExecutionId: string | null
  outputs?: Record<string, FlowNodeOutputDto>
  rootPath?: string
  hideOutput?: boolean
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
      {hasOutput && !hideOutput && rootPath !== undefined && flowExecutionId && <div className="flow-run-explorer"><FlowOutputExplorer key={`${flowExecutionId}:${entry.nodeId}`} rootPath={rootPath} flowExecutionId={flowExecutionId} nodeId={entry.nodeId} scope={info.capturesRequest ? 'request' : 'response'} /></div>}
      {hasOutput && !hideOutput && rootPath === undefined && outputs && (
        // A historical node without an output preview had no response stored.
        <NodeOutputBody
          key={entry.nodeId}
          nodeId={entry.nodeId}
          state={{ status: 'ready', output: outputs[entry.nodeId] ?? null }}
          unavailableMessage={t('flows.runLog.outputNotStored')}
        />
      )}
      {hasOutput && !hideOutput && rootPath === undefined && !outputs && flowExecutionId && (
        <NodeOutput key={`${flowExecutionId}-${entry.nodeId}`} flowExecutionId={flowExecutionId} nodeId={entry.nodeId} />
      )}
    </dl>
  )
}

type OutputState = { key: string; output: FlowNodeOutputDto | null; failed: boolean }

/** Legacy output preview requested only when selected, separately from progress events. */
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
  /** Empty-output text; the default explains the latest-run lifetime. */
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
      // If clipboard access fails, leave the reference visible for manual copying.
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
