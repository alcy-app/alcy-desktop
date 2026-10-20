import { useState } from 'react'
import type { EffectiveVariable } from '../request-workbench/collection-tree'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Select } from '../../shared/ui/Select'
import type { AncestorRequestRef } from './NodeInspectorPanel'
import { FlowOutputExplorer, FlowReferenceActions } from './FlowOutputExplorer'
import { FLOW_REFERENCE_MIME } from './flow-reference'
import { FlowDatasetFields } from './FlowDatasetFields'
import type { FlowDatasetSource } from './FlowDatasetFields'

export interface FlowVariableDefinition {
  name: string
  value?: string
  source: string
}

interface Props {
  outputVersions?: Record<string, number>
  flowId?: string
  datasets?: FlowDatasetSource[]
  variables: EffectiveVariable[]
  definitions: FlowVariableDefinition[]
  ancestors: AncestorRequestRef[]
  rootPath: string
  flowExecutionId: string | null
  load?: boolean
}

export function FlowDataBrowser({ variables, definitions, ancestors, rootPath, flowExecutionId, load, flowId = '', datasets = [], outputVersions = {} }: Props) {
  const { t } = useLanguage()
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [source, setSource] = useState(ancestors[0]?.nodeId ?? '')
  const selected = ancestors.find((ancestor) => ancestor.nodeId === source) ?? ancestors[0]
  const needle = query.toLowerCase().trim()
  const rows = [
    ...definitions.map((definition) => ({ ...definition, sensitive: false, value: definition.value ?? t('flows.studio.unresolved') })),
    ...variables.filter((variable) => !definitions.some((definition) => definition.name === variable.name)).map((variable) => ({ name: variable.name, value: variable.sensitive ? '••••••••' : variable.value, sensitive: variable.sensitive, source: variable.source?.name ?? t('flows.studio.environment') })),
  ].filter((row) => !needle || row.name.toLowerCase().includes(needle) || row.source.toLowerCase().includes(needle))
  const matchingAncestors = ancestors.filter((ancestor) => !needle || ancestor.label.toLowerCase().includes(needle))
  return <section className="flow-data-browser" data-flow-source aria-label={t('flows.studio.sources')}>
    <p className="flow-inspector-hint">{t('flows.studio.selectTarget')}</p>
    {load && <p className="flow-data-notice">{t('flows.studio.loadData')}</p>}
    <input type="search" className="ui-input" maxLength={256} value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0) }} placeholder={t('flows.studio.searchVariables')} aria-label={t('flows.studio.searchVariables')} />
    {load && datasets.length > 0 && <FlowDatasetFields rootPath={rootPath} flowId={flowId} sources={datasets} query={query} />}
    {rows.length > 0 && <div className="flow-data-variable-list">
      {rows.slice(offset, offset + 100).map((row, index) => <div className="flow-data-field flow-data-variable" key={`${row.source}-${row.name}-${index}`} draggable onDragStart={(event) => { event.dataTransfer.setData(FLOW_REFERENCE_MIME, `{{${row.name}}}`); event.dataTransfer.effectAllowed = 'copy' }}>
        <span className="flow-data-variable-name"><strong>{row.name}</strong><small>{row.source}</small></span><code title={row.sensitive ? undefined : row.value}>{row.value}</code><FlowReferenceActions reference={`{{${row.name}}}`} />
      </div>)}
      {rows.length > 100 && <div className="flow-data-pagination"><Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>{t('flows.studio.previousPage')}</Button><Button size="sm" variant="ghost" disabled={offset + 100 >= rows.length} onClick={() => setOffset(offset + 100)}>{t('flows.studio.nextPage')}</Button></div>}
    </div>}
    {!load && matchingAncestors.length > 0 && <>
      <label className="flow-inspector-field-label" htmlFor="flow-source-node">{t('flows.studio.previousNodes')}</label>
      <Select id="flow-source-node" value={selected?.nodeId ?? ''} onChange={(event) => setSource(event.target.value)}>{matchingAncestors.slice(0, 100).map((ancestor) => <option key={ancestor.nodeId} value={ancestor.nodeId}>{ancestor.label}</option>)}</Select>
      {!flowExecutionId && selected && selected.output !== 'mockServer' && <div className="flow-data-field"><code>{selected.output === 'mockRequest' ? 'request.body' : 'response.body'}</code><FlowReferenceActions reference={`{{nodes.${selected.nodeId}.${selected.output === 'mockRequest' ? 'request' : 'response'}.body}}`} /></div>}
      {selected?.output === 'mockServer' ? <div className="flow-data-field"><code>{`{{nodes.${selected.nodeId}.server.url}}`}</code><FlowReferenceActions reference={`{{nodes.${selected.nodeId}.server.url}}`} /></div> : selected && <FlowOutputExplorer key={`${selected.nodeId}:${flowExecutionId}`} version={outputVersions[selected.nodeId] ?? 0} rootPath={rootPath} flowExecutionId={flowExecutionId} nodeId={selected.nodeId} scope={selected.output === 'mockRequest' ? 'request' : 'response'} />}
    </>}
    {rows.length === 0 && matchingAncestors.length === 0 && datasets.length === 0 && <p className="flow-studio-empty">{t('flows.studio.noSources')}</p>}
  </section>
}
