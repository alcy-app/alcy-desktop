import { useEffect, useState } from 'react'
import { inspectLoadDataset } from '../../bindings/inspect-load-dataset'
import type { LoadDatasetFieldsDto } from '../../bindings/inspect-load-dataset'
import { cancelFlowOutputQuery } from '../../bindings/inspect-flow-output'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Select } from '../../shared/ui/Select'
import { FlowReferenceActions } from './FlowOutputExplorer'
import { FLOW_REFERENCE_MIME, useFlowMapping } from './flow-reference'

export interface FlowDatasetSource { nodeId: string; assetId: string; label: string }

export function FlowDatasetFields({ rootPath, flowId, sources, query = '' }: { rootPath: string; flowId: string; sources: FlowDatasetSource[]; query?: string }) {
  const { t } = useLanguage()
  const { registerReferences } = useFlowMapping()
  const [nodeId, setNodeId] = useState(sources[0]?.nodeId ?? '')
  const [location, setLocation] = useState({ assetId: '', query: '', offset: 0, previous: [] as number[] })
  const source = sources.find((item) => item.nodeId === nodeId) ?? sources[0]
  const assetId = source?.assetId
  const offset = location.assetId === assetId && location.query === query ? location.offset : 0
  const previous = location.assetId === assetId && location.query === query ? location.previous : []
  const key = JSON.stringify([rootPath, flowId, assetId, offset, query])
  const [state, setState] = useState<{ key: string; value: LoadDatasetFieldsDto | null } | null>(null)
  useEffect(() => {
    if (!assetId) return
    const queryId = crypto.randomUUID()
    let active = true
    const timer = window.setTimeout(() => { void inspectLoadDataset({ rootPath, flowId, assetId, offset, queryId, query }).then((value) => { if (active) { setState({ key, value }); registerReferences(value.fields.flatMap((field) => field.reference ? [field.reference] : [])) } }).catch(() => { if (active) setState({ key, value: null }) }) }, 180)
    return () => { active = false; window.clearTimeout(timer); void cancelFlowOutputQuery(queryId).catch(() => undefined) }
  }, [rootPath, flowId, assetId, offset, key, query, registerReferences])
  if (!source) return null
  const result = state?.key === key ? state.value : undefined
  return <div className="flow-dataset-fields">
    <Select aria-label={t('flows.loadNode.dataset.label')} value={source.nodeId} onChange={(event) => { setNodeId(event.target.value); setLocation({ assetId: '', query: '', offset: 0, previous: [] }) }}>{sources.map((item) => <option key={item.nodeId} value={item.nodeId}>{item.label}</option>)}</Select>
    <p className="flow-inspector-hint">{t('flows.studio.datasetExample')}</p>
    {result === undefined ? <p className="flow-studio-empty">{t('flows.studio.loading')}</p> : result === null ? <p className="flow-data-notice">{t('flows.studio.noOutput')}</p> : <>
      <div className="flow-data-variable-list">{result.fields.map((field, index) => <div className="flow-data-field" key={`${field.name}-${index}`} draggable={Boolean(field.reference)} onDragStart={(event) => { if (field.reference) { event.dataTransfer.setData(FLOW_REFERENCE_MIME, field.reference); event.dataTransfer.effectAllowed = 'copy' } }}><span>{field.name}</span><code>{field.preview}</code><FlowReferenceActions reference={field.reference} /></div>)}</div>
      {result.fields.length === 0 && <p className="flow-studio-empty">{t('flows.studio.noFields')}</p>}
      <div className="flow-data-pagination"><Button size="sm" variant="ghost" disabled={previous.length === 0} onClick={() => setLocation({ assetId: assetId ?? '', query, offset: previous.at(-1) ?? 0, previous: previous.slice(0, -1) })}>{t('flows.studio.previousPage')}</Button><Button size="sm" variant="ghost" disabled={result.nextOffset === null} onClick={() => setLocation({ assetId: assetId ?? '', query, offset: result.nextOffset ?? 0, previous: [...previous, offset] })}>{t('flows.studio.nextPage')}</Button></div>
    </>}
  </div>
}
