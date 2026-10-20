import { useCallback } from 'react'
import type { Node, NodeProps } from '@xyflow/react'
import { useLanguage } from '../../shared/i18n/use-language'
import { CopyIcon } from '../../shared/ui/icons'
import { IconButton } from '../../shared/ui/IconButton'
import { useToast } from '../../shared/ui/use-toast'
import { requestMethodLabel } from '../request-workbench/collection-tree'
import type { RequestSummary, TreeNode } from '../request-workbench/collection-tree'
import type { EnvironmentVariableDto } from '../../bindings/list-environments'
import { describeVariable } from '../request-workbench/template-highlight'
import { FlowNodeCard } from './FlowNodeCard'
import { FlowRequestCard } from './FlowRequestCard'
import { RequestEndpoint } from './RequestEndpoint'
import { UrlPreview } from './UrlPreview'
import type { NodeRunStatus } from './use-flow-run'

/** Collection requests resolve live in FlowCanvas. An empty requestId denotes
 * an unconfigured node; a nonempty unresolved ID denotes a broken reference. */
export type RequestNodeType = Node<
  {
    requestId: string
    request: RequestSummary | null
    runStatus: NodeRunStatus
    collections: TreeNode[]
    environmentVariables: EnvironmentVariableDto[]
    onSelectRequest: (request: RequestSummary) => void
    onOpenSettings: () => void
    onDelete: () => void
    onDuplicate: () => void
    visited?: boolean
    /** Historical snapshots cannot edit or replace the request. */
    readOnly?: boolean
  },
  'request'
>

/** Method badge using the request editor's method colors. */
export function RequestMethodBadge({ request }: { request: RequestSummary }) {
  const tone = request.protocol === 'rest' ? request.content.method : request.protocol
  return <span className={`flow-node-method flow-node-method--${tone}`}>{requestMethodLabel(request)}</span>
}

/** Short node ID and an action to copy its response reference. */
export function NodeReferenceMeta({ id }: { id: string }) {
  const { t } = useLanguage()
  const { showToast } = useToast()

  const handleCopyReference = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(`{{nodes.${id}.response.body}}`)
      showToast(t('toasts.nodeReferenceCopied'))
    } catch {
      // Clipboard failures must not show a success toast.
    }
  }, [id, showToast, t])

  return (
    <span className="flow-node-id-row">
      <span className="flow-node-id" title={id}>
        #{id.slice(0, 8)}
      </span>
      <span className="nodrag">
        <IconButton icon={<CopyIcon size={11} />} label={t('flows.canvas.copyNodeReferenceAria')} size="sm" onClick={() => void handleCopyReference()} />
      </span>
    </span>
  )
}

export function RequestNode({ data }: NodeProps<RequestNodeType>) {
  const { t } = useLanguage()
  const summary = data.request
    ? <><RequestMethodBadge request={data.request} /><span><UrlPreview template={data.request.content.endpointUrl || t('flows.canvas.requestEmptyUrl')} describe={(name) => name.startsWith('nodes.') ? t('flows.canvas.urlNodeVariableHint') : describeVariable(t, name, data.environmentVariables)} /></span></>
    : <span>{t(data.requestId === '' ? 'flows.canvas.chooseRequestLabel' : 'flows.canvas.requestNodeMissing')}</span>
  const endpoint = <RequestEndpoint url={data.request?.content.endpointUrl} collections={data.collections} onSelectRequest={data.onSelectRequest} configured={Boolean(data.request)} readOnly={data.readOnly}>{summary}</RequestEndpoint>
  const outputs = [
    { id: 'success' as const, label: t('flows.canvas.requestSuccessLabel'), variant: 'positive' as const },
    { id: 'failure' as const, label: t('flows.canvas.requestFailureLabel'), variant: 'negative' as const },
  ]
  return <>
    {data.request ? <FlowRequestCard kind="request" request={data.request} runStatus={data.runStatus} visited={data.visited} readOnly={data.readOnly} onOpenSettings={data.onOpenSettings} onDuplicate={data.onDuplicate} onDelete={data.onDelete}>{endpoint}</FlowRequestCard> : <FlowNodeCard kind="request" runStatus={data.runStatus} visited={data.visited} readOnly={data.readOnly} outputs={outputs} onOpenSettings={data.onOpenSettings} onDuplicate={data.onDuplicate} onDelete={data.onDelete}>{endpoint}</FlowNodeCard>}
  </>
}
