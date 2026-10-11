import { useCallback, useState } from 'react'
import type { MouseEvent } from 'react'
import type { Node, NodeProps } from '@xyflow/react'
import { useLanguage } from '../../shared/i18n/use-language'
import { AlertIcon, CopyIcon, SendIcon } from '../../shared/ui/icons'
import { IconButton } from '../../shared/ui/IconButton'
import { useToast } from '../../shared/ui/use-toast'
import type { RequestSummary, TreeNode } from '../request-workbench/collection-tree'
import type { EnvironmentVariableDto } from '../../bindings/list-environments'
import { describeVariable } from '../request-workbench/template-highlight'
import { FlowNodeCard } from './FlowNodeCard'
import type { NodeOutput } from './FlowNodeCard'
import { RequestPicker } from './RequestPicker'
import type { NodeRunStatus } from './use-flow-run'
import { UrlPreview } from './UrlPreview'

/** `request` é resolvido ao vivo por `FlowCanvas` a partir de `collections`
 * a cada render (não uma cópia estática) — para refletir renomeações/edições
 * feitas na coleção depois que o node foi criado. `null` quando `requestId`
 * está vazio (node "Requisição de API" recém-criado, ainda não configurado)
 * ou quando não existe mais em nenhuma coleção do workspace (referência
 * quebrada) — `RequestNode` distingue os dois casos por `requestId === ''`. */
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
    /** Snapshot de um run do histórico: sem trocar requisição, configurar nem editar o node. */
    readOnly?: boolean
  },
  'request'
>

/** Método da requisição no cabeçalho do cartão, com a mesma cor por método
 * do editor de requisições. */
export function RequestMethodBadge({ request }: { request: RequestSummary }) {
  const method = request.protocol === 'graphql' ? 'graphql' : request.content.method
  return <span className={`flow-node-method flow-node-method--${method}`}>{request.protocol === 'graphql' ? 'GraphQL' : method.toUpperCase()}</span>
}

/** Id curto do node e botão de copiar a referência `{{nodes.<id>...}}`. */
export function NodeReferenceMeta({ id }: { id: string }) {
  const { t } = useLanguage()
  const { showToast } = useToast()

  const handleCopyReference = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(`{{nodes.${id}.response.body}}`)
      showToast(t('toasts.nodeReferenceCopied'))
    } catch {
      // Clipboard indisponível (permissão negada, contexto não seguro) — sem toast de sucesso.
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

export function RequestNode({ id, data }: NodeProps<RequestNodeType>) {
  const { t } = useLanguage()
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null)

  const openPicker = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    setPickerAnchor(event.currentTarget.getBoundingClientRect())
  }

  const picker = pickerAnchor && (
    <RequestPicker
      anchor={pickerAnchor}
      collections={data.collections}
      onClose={() => setPickerAnchor(null)}
      onSelectRequest={(request) => {
        data.onSelectRequest(request)
        setPickerAnchor(null)
      }}
    />
  )

  const outputs: NodeOutput[] = [
    { id: 'success', label: t('flows.canvas.requestSuccessLabel'), variant: 'positive' },
    { id: 'failure', label: t('flows.canvas.requestFailureLabel'), variant: 'negative' },
  ]

  // Sem requisição resolvida: recém-criado (`requestId` vazio) ou referência
  // quebrada. As saídas ficam mesmo assim — no domínio ele já é um `Request`,
  // e uma edge saindo dele sem handle seria rejeitada no save.
  if (!data.request) {
    const isUnconfigured = data.requestId === ''
    return (
      <FlowNodeCard
        kind="request"
        className={isUnconfigured ? 'flow-node--unconfigured' : 'flow-node--broken'}
        runStatus={data.runStatus}
        visited={data.visited}
        readOnly={data.readOnly}
        outputs={outputs}
        onDuplicate={data.onDuplicate}
        onDelete={data.onDelete}
      >
        <button
          type="button"
          className="flow-node-cta nodrag"
          aria-label={t('flows.canvas.chooseRequestAria')}
          disabled={data.readOnly}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={openPicker}
        >
          {isUnconfigured ? <SendIcon size={12} /> : <AlertIcon size={12} />}
          <span>{isUnconfigured ? t('flows.canvas.chooseRequestLabel') : t('flows.canvas.requestNodeMissing')}</span>
        </button>
        {picker}
      </FlowNodeCard>
    )
  }

  return (
    <FlowNodeCard
      kind="request"
      title={data.request.name || t('common.unnamed')}
      titleBadge={<RequestMethodBadge request={data.request} />}
      runStatus={data.runStatus}
      visited={data.visited}
      readOnly={data.readOnly}
      outputs={outputs}
      onOpenSettings={data.onOpenSettings}
      meta={<NodeReferenceMeta id={id} />}
      onDuplicate={data.onDuplicate}
      onDelete={data.onDelete}
    >
      <button
        type="button"
        className="flow-node-url nodrag"
        aria-label={t('flows.canvas.changeRequestAria')}
        disabled={data.readOnly}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={openPicker}
      >
        {data.request.content.endpointUrl ? (
          <UrlPreview
            template={data.request.content.endpointUrl}
            describe={(name) =>
              name.startsWith('nodes.') ? t('flows.canvas.urlNodeVariableHint') : describeVariable(t, name, data.environmentVariables)
            }
          />
        ) : (
          <span className="flow-node-placeholder">{t('flows.canvas.requestEmptyUrl')}</span>
        )}
      </button>
      {picker}
    </FlowNodeCard>
  )
}
