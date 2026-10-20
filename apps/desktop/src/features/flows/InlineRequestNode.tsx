import type { NodeProps } from '@xyflow/react'
import { useLanguage } from '../../shared/i18n/use-language'
import { describeVariable } from '../request-workbench/template-highlight'
import { FlowRequestCard } from './FlowRequestCard'
import { RequestMethodBadge } from './RequestNode'
import type { SimpleFlowNodeType } from './simple-node-types'
import { UrlPreview } from './UrlPreview'

/** Inline requests use the same compact overview as collection requests. */
export function InlineRequestNode({ data }: NodeProps<SimpleFlowNodeType>) {
  const { t } = useLanguage()
  if (data.config.kind !== 'inlineRequest') return null
  const { request } = data.config
  const summary = <><RequestMethodBadge request={request} /><span><UrlPreview template={request.content.endpointUrl || t('flows.canvas.inlineRequestEmptyUrl')} describe={(name) => name.startsWith('nodes.') ? t('flows.canvas.urlNodeVariableHint') : describeVariable(t, name, data.environmentVariables ?? [])} /></span></>
  return <FlowRequestCard kind="inlineRequest" request={request} runStatus={data.runStatus} visited={data.visited} readOnly={data.readOnly} onOpenSettings={data.onOpenSettings} onDuplicate={data.onDuplicate} onDelete={data.onDelete}>{data.readOnly ? <span className="flow-node-request-summary">{summary}</span> : <button type="button" className="flow-node-request-summary flow-node-request-picker nodrag nopan" title={request.content.endpointUrl} aria-label={t('flows.canvas.openNodeSettingsAria')} onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); (data.onEditRequest ?? data.onOpenSettings)() }}>{summary}</button>}</FlowRequestCard>
}
