import { useEffect, useState } from 'react'
import { cancelFlowOutputQuery, inspectFlowOutput } from '../../bindings/inspect-flow-output'
import type { FlowOutputInspectionDto } from '../../bindings/inspect-flow-output'
import { useLanguage } from '../../shared/i18n/use-language'
import { Badge } from '../../shared/ui/Badge'
import { Button } from '../../shared/ui/Button'
import { IconButton } from '../../shared/ui/IconButton'
import { ChevronRightIcon, CopyIcon, PlusIcon, RefreshIcon, Spinner } from '../../shared/ui/icons'
import { useToast } from '../../shared/ui/use-toast'
import { FLOW_REFERENCE_MIME, referenceFromPointer, useFlowMapping } from './flow-reference'

interface Props {
  version?: number
  rootPath: string
  flowExecutionId: string | null
  nodeId: string
  snapshotNodeId?: string
  scope?: 'request' | 'response'
  onReference?: (reference: string, preview: string) => void
}

export function FlowReferenceActions({ reference }: { reference: string | null }) {
  const { t } = useLanguage()
  const { insert, hasTarget } = useFlowMapping()
  const { showToast } = useToast()
  if (!reference) return <span className="flow-data-unmappable" title={t('flows.studio.unmappable')}>—</span>
  return <span className="flow-data-actions" draggable onDragStart={(event) => { event.dataTransfer.setData(FLOW_REFERENCE_MIME, reference); event.dataTransfer.effectAllowed = 'copy' }}>
    <IconButton icon={<PlusIcon size={12} />} label={t('flows.studio.insertReference')} disabled={!hasTarget} onMouseDown={(event) => event.preventDefault()} onClick={() => insert(reference)} />
    <IconButton icon={<CopyIcon size={12} />} label={t('flows.canvas.copyVariableAria', { reference })} onClick={() => { void navigator.clipboard.writeText(reference).then(() => showToast(t('toasts.nodeReferenceCopied'))).catch(() => showToast(t('flows.studio.copyFailed'), 'error')) }} />
  </span>
}

export function FlowOutputExplorer({ rootPath, flowExecutionId, nodeId, snapshotNodeId = nodeId, scope = 'response', onReference, version = 0 }: Props) {
  const { t } = useLanguage()
  const { registerReferences } = useFlowMapping()
  const [pointer, setPointer] = useState('')
  const [query, setQuery] = useState('')
  const [format, setFormat] = useState<'auto' | 'json' | 'text'>('auto')
  const [cursor, setCursor] = useState<string | null>(null)
  const [previous, setPrevious] = useState<(string | null)[]>([])
  const [navigationVersion, setNavigationVersion] = useState(version)
  if (navigationVersion !== version) { setNavigationVersion(version); setCursor(null); setPrevious([]) }
  const [state, setState] = useState<{ key: string; result: FlowOutputInspectionDto | null; error: string } | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const requestKey = JSON.stringify([rootPath, flowExecutionId, nodeId, snapshotNodeId, pointer, debouncedQuery, cursor, format, refresh, version])
  const result = state?.key === requestKey ? state.result : null
  const error = state?.key === requestKey ? state.error : ''
  const loading = Boolean(flowExecutionId && state?.key !== requestKey)
  useEffect(() => { registerReferences(result?.page?.entries.flatMap((entry) => { const reference = referenceFromPointer(nodeId, entry.pointer, scope); return reference ? [reference] : [] }) ?? []) }, [result, nodeId, scope, registerReferences])
  useEffect(() => { const timer = window.setTimeout(() => { setDebouncedQuery(query); setCursor(null); setPrevious([]) }, 180); return () => window.clearTimeout(timer) }, [query])

  useEffect(() => {
    if (!flowExecutionId) return
    let active = true
    let retry: number | undefined
    let queryId = crypto.randomUUID()
    const load = async (text: boolean, attempts = 0) => {
      queryId = crypto.randomUUID()
      try {
        const next = await inspectFlowOutput({ rootPath, flowExecutionId, nodeId: snapshotNodeId, queryId, pointer, query: debouncedQuery, cursor, text })
        if (!active) return
        if (next.availability === 'pending' && attempts < 20) { retry = window.setTimeout(() => { void load(text, attempts + 1) }, 250); return }
        setState({ key: requestKey, result: next, error: '' })
      } catch (reason) {
        if (!active) return
        if (String(reason) === 'staleRevision' && !cursor && attempts < 3) { retry = window.setTimeout(() => { void load(text, attempts + 1) }, 100); return }
        if (format === 'auto' && !text && String(reason) === 'invalidJson') { void load(true); return }
        setState({ key: requestKey, result: null, error: String(reason) })
      }
    }
    void load(format === 'text')
    return () => { active = false; window.clearTimeout(retry); void cancelFlowOutputQuery(queryId).catch(() => undefined) }
  }, [rootPath, flowExecutionId, snapshotNodeId, pointer, debouncedQuery, cursor, format, refresh, requestKey])

  const navigate = (next: string) => { setPointer(next); setCursor(null); setPrevious([]); setQuery(''); setDebouncedQuery(''); setFormat('auto') }
  const refreshOutput = () => { if (error) navigate(''); setCursor(null); setPrevious([]); setRefresh((value) => value + 1) }
  const rootReference = referenceFromPointer(nodeId, pointer, scope)
  return <section className="flow-data-explorer" data-flow-source aria-label={t('flows.studio.output')}>
    <div className="flow-data-toolbar">
      <div className="flow-data-formats" role="group" aria-label={t('flows.studio.format')}>
        {(['auto', 'json', 'text'] as const).map((value) => <button key={value} type="button" aria-pressed={format === value} onClick={() => { setFormat(value); setCursor(null); setPrevious([]) }}>{value === 'auto' ? t('flows.studio.auto') : value === 'json' ? 'JSON' : t('flows.studio.text')}</button>)}
      </div>
      <IconButton icon={<RefreshIcon size={12} />} label={t('common.retry')} onClick={refreshOutput} />
    </div>
    {!flowExecutionId ? <p className="flow-studio-empty">{t('flows.studio.runToInspect')}</p> : loading ? <p className="flow-studio-empty" role="status"><Spinner size={14} /> {t('flows.studio.loading')}</p> : error ? <div className="flow-studio-empty" role="status"><p>{t(error === 'invalidJson' ? 'flows.studio.invalidJson' : error === 'notScalar' ? 'flows.studio.notScalar' : error === 'staleRevision' || error === 'invalidCursor' ? 'flows.studio.stale' : 'flows.studio.noOutput')}</p><Button size="sm" variant="ghost" onClick={refreshOutput}>{t('common.retry')}</Button></div> : result && <>
      <div className="flow-data-summary"><Badge tone={result.output.statusCode >= 400 ? 'error' : 'neutral'}>{scope === 'request' ? result.output.request?.method ?? 'HTTP' : result.output.statusCode}</Badge><span>{result.output.durationMs} ms</span><span>{new Intl.NumberFormat().format(result.output.sizeBytes)} B</span><span>{t('flows.studio.lastOccurrence')}</span></div>
      {result.availability !== 'available' && <p className="flow-data-notice">{t('flows.studio.previewOnly', { reason: t(`flows.studio.availability.${result.availability}`) })}</p>}
      {!pointer && <div className="flow-data-metadata">
        {scope === 'response' && <div className="flow-data-field"><span>status</span><code>{result.output.statusCode}</code><FlowReferenceActions reference={`{{nodes.${nodeId}.response.status}}`} /></div>}
        {scope === 'request' && ['method', 'path'].map((key) => <div className="flow-data-field" key={key}><span>{key}</span><code>{result.output.request?.[key as 'method' | 'path']}</code><FlowReferenceActions reference={`{{nodes.${nodeId}.request.${key}}}`} /></div>)}
        <details><summary>{t('flows.studio.headers')} ({result.output.headers.length})</summary>{result.output.headers.map((header, index) => <div className="flow-data-field" key={`${header.name}-${index}`}><span title={header.name}>{header.name}</span><code>{header.value}</code><FlowReferenceActions reference={/[.{}]/.test(header.name) ? null : `{{nodes.${nodeId}.${scope}.headers.${header.name}}}`} /></div>)}</details>
      </div>}
      <div className="flow-data-path"><button type="button" onClick={() => navigate('')}>body</button>{pointer && <><ChevronRightIcon size={11} /><button type="button" title={pointer} onClick={() => navigate(pointer.slice(0, pointer.lastIndexOf('/')))}>{pointer}</button></>}<FlowReferenceActions reference={rootReference} /></div>
      {result.page ? <>
        <input type="search" className="ui-input flow-data-search" value={query} placeholder={t('flows.studio.searchFields')} aria-label={t('flows.studio.searchFields')} onChange={(event) => setQuery(event.target.value)} />
        <div className="flow-data-rows" role="tree" aria-label={t('flows.studio.fields')}>
          {result.page.entries.map((field, index) => {
            const reference = field.pointer ? referenceFromPointer(nodeId, field.pointer, scope) : null
            const container = field.kind === 'object' || field.kind === 'array'
            return <div key={`${field.pointer}-${index}`} className="flow-data-field" role="treeitem" aria-expanded={container ? false : undefined} draggable={reference !== null} onDragStart={(event) => { if (reference) { event.dataTransfer.setData(FLOW_REFERENCE_MIME, reference); event.dataTransfer.effectAllowed = 'copy' } }}>
              <button type="button" className="flow-data-key" title={field.pointer} disabled={!field.pointer} onClick={() => { navigate(field.pointer); if (!container) setFormat('text') }}>{container && <ChevronRightIcon size={12} />}<span>{field.key}</span></button>
              <span className={`flow-data-value flow-data-value--${field.kind}`} title={field.preview}><small>{field.kind}</small>{field.preview}</span>
              <FlowReferenceActions reference={reference} />
            </div>
          })}
          {result.page.entries.length === 0 && <p className="flow-studio-empty">{result.page.preview || t('flows.studio.noFields')}</p>}
        </div>
      </> : result.text !== null ? <pre className="flow-data-text">{result.text || t('common.empty')}</pre> : <p className="flow-studio-empty">{t('flows.studio.noOutput')}</p>}
      {(previous.length > 0 || result.nextCursor) && <div className="flow-data-pagination"><Button size="sm" variant="ghost" disabled={previous.length === 0} onClick={() => { setCursor(previous.at(-1) ?? null); setPrevious((items) => items.slice(0, -1)) }}>{t('flows.studio.previousPage')}</Button><span>{previous.length + 1}</span><Button size="sm" variant="ghost" disabled={!result.nextCursor} onClick={() => { setPrevious((items) => [...items, cursor]); setCursor(result.nextCursor) }}>{t('flows.studio.nextPage')}</Button></div>}
    </>}
    {result?.page && onReference && <button type="button" className="flow-data-use-root" onClick={() => { if (rootReference) onReference(rootReference, result.page?.preview ?? '') }}>{t('flows.studio.useReference')}</button>}
  </section>
}
