import { useEffect, useState } from 'react'
import { cancelFlowOutputQuery, inspectFlowOutput } from '../../bindings/inspect-flow-output'
import type { FlowOutputFieldDto, FlowOutputInspectionDto } from '../../bindings/inspect-flow-output'
import { useLanguage } from '../../shared/i18n/use-language'
import { ChevronDownIcon, ChevronRightIcon } from '../../shared/ui/icons'
import type { DisplayBodySource } from './display-output-source'

export function DisplayResponseTree({ source, onInvalidJson }: { source: DisplayBodySource; onInvalidJson: () => void }) {
  return <ul className="flow-output-tree" role="tree"><ResponseBranch source={source} onInvalidJson={onInvalidJson} /></ul>
}

/** Only expanded containers load a bounded child page. Collapsing a branch cancels its reads and unmounts descendants. */
function ResponseBranch({ source, field, depth = 0, revision, onInvalidJson }: { source: DisplayBodySource; field?: FlowOutputFieldDto; depth?: number; revision?: string; onInvalidJson: () => void }) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(!field)
  const [cursor, setCursor] = useState<string | null>(null)
  const [previous, setPrevious] = useState<(string | null)[]>([])
  const [refresh, setRefresh] = useState(0)
  const [state, setState] = useState<{ requestKey: string; result?: FlowOutputInspectionDto; error?: string } | null>(null)
  const { rootPath, flowExecutionId, nodeId } = source
  const pointer = field?.pointer ?? ''
  const requestKey = JSON.stringify([pointer, cursor, refresh, revision])
  const result = state?.requestKey === requestKey ? state.result : undefined
  const error = state?.requestKey === requestKey ? state.error : undefined
  const kind = field?.kind ?? result?.page?.kind ?? 'object'
  const container = kind === 'object' || kind === 'array'
  const loading = open && container && state?.requestKey !== requestKey
  const label = field?.key ?? 'body'
  const preview = result?.page?.preview ?? field?.preview ?? ''
  const count = result?.page?.total ?? (preview || '…')
  const summary = kind === 'object' ? `{${count}}` : kind === 'array' ? `[${count}]` : kind === 'string' ? `"${preview}"` : preview

  useEffect(() => {
    if (!open || (field && field.kind !== 'object' && field.kind !== 'array')) return
    let active = true
    let queryId = ''
    let retry: number | undefined
    const load = async (attempt = 0) => {
      queryId = crypto.randomUUID()
      try {
        const next = await inspectFlowOutput({ rootPath, flowExecutionId, nodeId, queryId, pointer, cursor, revision, text: false })
        if (!active) return
        if (next.availability === 'pending' && attempt < 20) { retry = window.setTimeout(() => { void load(attempt + 1) }, 250); return }
        setState({ requestKey, result: next })
      } catch (reason) {
        if (!active) return
        if (pointer === '' && String(reason) === 'invalidJson') { onInvalidJson(); return }
        setState({ requestKey, error: String(reason) })
      }
    }
    void load()
    return () => { active = false; window.clearTimeout(retry); if (queryId) void cancelFlowOutputQuery(queryId).catch(() => undefined) }
  }, [rootPath, flowExecutionId, nodeId, pointer, cursor, revision, open, field, requestKey, onInvalidJson])

  return <li role="treeitem" aria-expanded={container ? open : undefined}>
    <button type="button" aria-label={`${label} ${summary}`} className="flow-output-row" style={{ paddingLeft: `calc(var(--space-1) + ${depth} * var(--space-3))` }} onClick={() => { if (container) setOpen((current) => !current) }} onKeyDown={(event) => {
      if (container && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) { event.preventDefault(); event.stopPropagation(); setOpen(event.key === 'ArrowRight') }
    }}>
      <span className="flow-output-chevron" aria-hidden="true">{container ? open ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} /> : null}</span>
      <span className="flow-output-key" title={label}>{label}</span>
      <span className={`flow-output-value flow-output-value--${kind}`} title={preview}>{summary}</span>
    </button>
    {open && <>
      {loading && <p className="flow-data-notice" role="status">{t('flows.studio.loading')}</p>}
      {error && <div className="flow-data-notice" role="status">{t(error === 'staleRevision' || error === 'invalidCursor' ? 'flows.studio.stale' : 'flows.studio.noOutput')} <button type="button" onClick={() => { setCursor(null); setPrevious([]); setRefresh((value) => value + 1) }}>{t('common.retry')}</button></div>}
      {result && <>
        {result.availability !== 'available' && <p className="flow-data-notice" role="status">{t('flows.studio.previewOnly', { reason: t(`flows.studio.availability.${result.availability}`) })}</p>}
        {container && <ul role="group">
          {result.page?.entries.map((entry) => <ResponseBranch key={entry.pointer} source={source} field={entry} depth={depth + 1} revision={result.revision} onInvalidJson={onInvalidJson} />)}
          {(previous.length > 0 || result.nextCursor) && <li role="none" className="flow-display-pagination">
            <button type="button" disabled={previous.length === 0} onClick={() => { setCursor(previous.at(-1) ?? null); setPrevious((items) => items.slice(0, -1)) }}>{t('flows.studio.previousPage')}</button>
            <span>{previous.length + 1}</span>
            <button type="button" disabled={!result.nextCursor} onClick={() => { setPrevious((items) => [...items, cursor]); setCursor(result.nextCursor) }}>{t('flows.studio.nextPage')}</button>
          </li>}
        </ul>}
      </>}
    </>}
  </li>
}
