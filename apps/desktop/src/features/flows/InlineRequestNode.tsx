import type { NodeProps } from '@xyflow/react'
import { useLanguage } from '../../shared/i18n/use-language'
import { describeVariable } from '../request-workbench/template-highlight'
import { FlowNodeCard } from './FlowNodeCard'
import { NodeReferenceMeta, RequestMethodBadge } from './RequestNode'
import type { SimpleFlowNodeType } from './simple-node-types'
import { UrlPreview } from './UrlPreview'

/** Requisição avulsa (spec 0086): a requisição inteira fica no flow e é
 * editada numa aba do workbench — clicar na URL abre essa aba. Mesmas saídas
 * `success`/`failure` do `RequestNode`. */
export function InlineRequestNode({ id, data }: NodeProps<SimpleFlowNodeType>) {
  const { t } = useLanguage()
  const { config } = data
  if (config.kind !== 'inlineRequest') return null
  const { request } = config

  return (
    <FlowNodeCard
      kind="inlineRequest"
      title={request.name || t('common.unnamed')}
      titleBadge={<RequestMethodBadge request={request} />}
      runStatus={data.runStatus}
      visited={data.visited}
      readOnly={data.readOnly}
      outputs={[
        { id: 'success', label: t('flows.canvas.requestSuccessLabel'), variant: 'positive' },
        { id: 'failure', label: t('flows.canvas.requestFailureLabel'), variant: 'negative' },
      ]}
      onOpenSettings={data.onOpenSettings}
      meta={<NodeReferenceMeta id={id} />}
      onDuplicate={data.onDuplicate}
      onDelete={data.onDelete}
    >
      <button
        type="button"
        className="flow-node-url nodrag"
        aria-label={t('flows.canvas.editInlineRequestAria')}
        disabled={data.readOnly || !data.onEditRequest}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          data.onEditRequest?.()
        }}
      >
        {request.content.endpointUrl ? (
          <UrlPreview
            template={request.content.endpointUrl}
            describe={(name) =>
              name.startsWith('nodes.') ? t('flows.canvas.urlNodeVariableHint') : describeVariable(t, name, data.environmentVariables ?? [])
            }
          />
        ) : (
          <span className="flow-node-placeholder">{t('flows.canvas.inlineRequestEmptyUrl')}</span>
        )}
      </button>
    </FlowNodeCard>
  )
}
