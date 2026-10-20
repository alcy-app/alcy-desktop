import type { ComponentProps } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import type { RequestSummary } from '../request-workbench/collection-tree'
import { FlowNodeCard } from './FlowNodeCard'

type Props = Omit<ComponentProps<typeof FlowNodeCard>, 'kind' | 'title' | 'outputs'> & {
  kind: 'request' | 'inlineRequest'
  request: RequestSummary
}

/** Request overview; input, scripts and response inspection stay in the inspector. */
export function FlowRequestCard({ kind, request, runStatus = { status: 'idle' }, ...props }: Props) {
  const { t } = useLanguage()
  const failed = runStatus.status === 'failed' || (runStatus.status === 'success' && runStatus.statusCode >= 400)
  const statusCode = runStatus.status === 'success' ? String(runStatus.statusCode) : undefined
  return <FlowNodeCard {...props} kind={kind} title={request.name || t('common.unnamed')} runStatus={runStatus} outputs={[
    { id: 'success', label: t('flows.canvas.requestSuccessLabel'), variant: 'positive', detail: !failed ? statusCode : undefined },
    { id: 'failure', label: t('flows.canvas.requestFailureLabel'), variant: 'negative', detail: failed ? statusCode : undefined },
  ]} />
}
