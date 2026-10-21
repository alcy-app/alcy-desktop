import { useCallback, useEffect, useState } from 'react'
import { cancelFlowOutputQuery, inspectFlowOutput } from '../../bindings/inspect-flow-output'
import type { FlowOutputInspectionDto } from '../../bindings/inspect-flow-output'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import type { DisplayFormat } from './display-format'
import { DisplayValue } from './DisplayValue'
import type { DisplayBodySource } from './display-output-source'
import { DisplayResponseTree } from './DisplayResponseTree'

export function DisplayOutput({ value, format, source, compact = false }: { value: string; format: DisplayFormat; source?: DisplayBodySource; compact?: boolean }) {
  if (!source) return <DisplayValue value={value} format={format} compact={compact} />
  return <ArchivedDisplay key={JSON.stringify(source)} source={source} fallback={value} format={format} compact={compact} />
}

function ArchivedDisplay(props: { source: DisplayBodySource; fallback: string; format: DisplayFormat; compact: boolean }) {
  const [plainText, setPlainText] = useState(false)
  const onInvalidJson = useCallback(() => setPlainText(true), [])
  return !plainText && (props.format === 'auto' || props.format === 'json')
    ? <DisplayResponseTree source={props.source} onInvalidJson={onInvalidJson} />
    : <ResponsePages {...props} />
}

/** Only the current body page stays in memory; obsolete reads are cancelled. */
function ResponsePages({ source, fallback, format, compact }: { source: DisplayBodySource; fallback: string; format: DisplayFormat; compact: boolean }) {
  const { t } = useLanguage()
  const [cursor, setCursor] = useState<string | null>(null)
  const [previous, setPrevious] = useState<(string | null)[]>([])
  const [refresh, setRefresh] = useState(0)
  const [state, setState] = useState<{ requestKey: string; result?: FlowOutputInspectionDto; error?: boolean } | null>(null)
  const requestKey = JSON.stringify([cursor, refresh])
  const result = state?.requestKey === requestKey ? state.result : undefined
  const error = state?.requestKey === requestKey && state.error
  const loading = state?.requestKey !== requestKey
  const unavailable = result?.availability !== 'available' ? result?.availability ?? 'unavailable' : 'unavailable'
  const { rootPath, flowExecutionId, nodeId } = source

  useEffect(() => {
    let active = true
    let queryId = ''
    let retry: number | undefined
    const load = async (attempt = 0) => {
      queryId = crypto.randomUUID()
      try {
        const next = await inspectFlowOutput({ rootPath, flowExecutionId, nodeId, queryId, cursor, text: true })
        if (!active) return
        if (next.availability === 'pending' && attempt < 20) { retry = window.setTimeout(() => { void load(attempt + 1) }, 250); return }
        setState({ requestKey, result: next })
      } catch (reason) {
        if (!active) return
        if (String(reason) === 'busy' && attempt < 20) { retry = window.setTimeout(() => { void load(attempt + 1) }, 250); return }
        if (String(reason) === 'staleRevision' && !cursor && attempt < 3) { retry = window.setTimeout(() => { void load(attempt + 1) }, 100); return }
        setState({ requestKey, error: true })
      }
    }
    void load()
    return () => { active = false; window.clearTimeout(retry); if (queryId) void cancelFlowOutputQuery(queryId).catch(() => undefined) }
  }, [rootPath, flowExecutionId, nodeId, cursor, requestKey])

  return <div className="flow-display-pages">
    {loading ? <p className="flow-studio-empty" role="status">{t('flows.studio.loading')}</p> : <>
      {(error || result?.availability !== 'available') && <p className="flow-data-notice" role="status">{t('flows.studio.previewOnly', { reason: t(`flows.studio.availability.${unavailable}`) })}</p>}
      <DisplayValue key={cursor} value={result?.text ?? fallback} format={format} compact={compact} partial={previous.length > 0 || Boolean(result?.nextCursor)} />
      {error && <Button variant="ghost" size="sm" onClick={() => { setCursor(null); setPrevious([]); setRefresh((value) => value + 1) }}>{t('common.retry')}</Button>}
    </>}
    {(previous.length > 0 || result?.nextCursor) && <div className="flow-display-pagination">
      <Button variant="ghost" size="sm" disabled={loading || previous.length === 0} onClick={() => { setCursor(previous.at(-1) ?? null); setPrevious((items) => items.slice(0, -1)) }}>{t('flows.studio.previousPage')}</Button>
      <span>{previous.length + 1}</span>
      <Button variant="ghost" size="sm" disabled={loading || !result?.nextCursor} onClick={() => { setPrevious((items) => [...items, cursor]); setCursor(result?.nextCursor ?? null) }}>{t('flows.studio.nextPage')}</Button>
    </div>}
  </div>
}
