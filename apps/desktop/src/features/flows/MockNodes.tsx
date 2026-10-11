import type { NodeProps } from '@xyflow/react'
import type { ReactNode } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { Badge } from '../../shared/ui/Badge'
import { FlowNodeCard } from './FlowNodeCard'
import type { NodeOutput } from './FlowNodeCard'
import { MOCK_CALL_COUNT_SYMBOL, findMockRoute, mockRouteLabel, mockRouteResponses } from './mock-nodes'
import type { MockStartInfo } from './mock-nodes'
import { NodeReferenceMeta } from './RequestNode'
import { formatSleepDuration } from './simple-node-types'
import type { SimpleFlowNodeType, SimpleNodeData } from './simple-node-types'

/** Cartão comum dos blocos de mock (spec 0121). Sem spinner nem animação
 * enquanto espera: dentro do viewport isso borra o canvas no WebKitGTK. */
function MockCard({ data, outputs, meta, children }: { data: SimpleNodeData; outputs?: NodeOutput[]; meta?: ReactNode; children: ReactNode }) {
  return (
    <FlowNodeCard
      kind={data.config.kind}
      runStatus={data.runStatus}
      visited={data.visited}
      readOnly={data.readOnly}
      outputs={outputs}
      meta={meta}
      onOpenSettings={data.onOpenSettings}
      onDuplicate={data.onDuplicate}
      onDelete={data.onDelete}
    >
      {children}
    </FlowNodeCard>
  )
}

/** Mock e rota para onde um bloco aponta, ou o que falta configurar. */
function MockTarget({ start, routeId }: { start: MockStartInfo | null | undefined; routeId?: string }) {
  const { t } = useLanguage()
  if (!start) return <span className="flow-node-placeholder">{t('flows.canvas.mockNoStartSelected')}</span>
  const route = routeId === undefined ? null : findMockRoute(start.server, routeId)
  return (
    <>
      <span className="flow-node-caption">{start.name || t('flows.canvas.mockUnnamedServer')}</span>
      {routeId !== undefined &&
        (route ? (
          <code className="flow-node-inline-code" title={route.name}>
            {mockRouteLabel(route)}
          </code>
        ) : (
          <span className="flow-node-placeholder">{t('flows.canvas.mockNoRouteSelected')}</span>
        ))}
    </>
  )
}

export function MockStartNode({ id, data }: NodeProps<SimpleFlowNodeType>) {
  const { t } = useLanguage()
  if (data.config.kind !== 'mockStart') return null
  const { source } = data.config
  const server = data.mockStart?.server ?? null
  const missing = source.type === 'saved' && source.serverId !== '' && !server

  return (
    <MockCard data={data} meta={<NodeReferenceMeta id={id} />}>
      <span>
        <Badge tone="neutral">{source.type === 'inline' ? t('flows.canvas.mockSourceInline') : t('flows.canvas.mockSourceSaved')}</Badge>
      </span>
      {source.type === 'inline' ? (
        <button
          type="button"
          className="flow-node-url nodrag"
          aria-label={t('flows.canvas.editInlineMockAria')}
          disabled={data.readOnly || !data.onEditMockServer}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            data.onEditMockServer?.()
          }}
        >
          {source.server.name || t('flows.canvas.mockUnnamedServer')}
        </button>
      ) : server ? (
        <span>{server.name}</span>
      ) : (
        <span className="flow-node-placeholder">
          {missing ? t('flows.canvas.mockServerMissing') : t('flows.canvas.mockNoServerSelected')}
        </span>
      )}
      {server && (
        <code className="flow-node-inline-code">
          127.0.0.1:{server.port} · {t('flows.canvas.mockRoutesCount', { count: String(server.routes.length) })}
        </code>
      )}
    </MockCard>
  )
}

export function MockStopNode({ data }: NodeProps<SimpleFlowNodeType>) {
  if (data.config.kind !== 'mockStop') return null
  return (
    <MockCard data={data}>
      <MockTarget start={data.mockStart} />
    </MockCard>
  )
}

export function MockWaitRequestNode({ id, data }: NodeProps<SimpleFlowNodeType>) {
  const { t } = useLanguage()
  if (data.config.kind !== 'mockWaitRequest') return null
  return (
    <MockCard
      data={data}
      meta={<NodeReferenceMeta id={id} />}
      outputs={[
        { id: 'true', label: t('flows.canvas.mockReceivedLabel'), variant: 'positive' },
        { id: 'false', label: t('flows.canvas.mockTimeoutLabel'), variant: 'neutral' },
      ]}
    >
      <MockTarget start={data.mockStart} routeId={data.config.routeId} />
      <span className="flow-node-duration">{t('flows.canvas.mockWaitUpTo', { duration: formatSleepDuration(data.config.timeoutMs) })}</span>
    </MockCard>
  )
}

export function MockSetResponseNode({ data }: NodeProps<SimpleFlowNodeType>) {
  const { t } = useLanguage()
  if (data.config.kind !== 'mockSetResponse') return null
  const { routeId, responseId } = data.config
  const route = findMockRoute(data.mockStart?.server ?? null, routeId)
  const response = route && responseId ? mockRouteResponses(route).find((candidate) => candidate.id === responseId) : null
  return (
    <MockCard data={data}>
      <MockTarget start={data.mockStart} routeId={routeId} />
      {route && (
        <span className="flow-node-caption">
          {responseId === null
            ? t('flows.canvas.mockResponseRules')
            : t('flows.canvas.mockRespondsWith', { name: response?.name || t('flows.canvas.mockResponseMissing') })}
        </span>
      )}
    </MockCard>
  )
}

export function MockAssertCallsNode({ data }: NodeProps<SimpleFlowNodeType>) {
  const { t } = useLanguage()
  if (data.config.kind !== 'mockAssertCalls') return null
  const { routeId, operator, count } = data.config
  return (
    <MockCard
      data={data}
      outputs={[
        { id: 'true', label: t('flows.canvas.mockAssertPassedLabel'), variant: 'positive' },
        { id: 'false', label: t('flows.canvas.mockAssertFailedLabel'), variant: 'negative' },
      ]}
    >
      <MockTarget start={data.mockStart} routeId={routeId} />
      <span className="flow-node-duration">
        {t('flows.canvas.mockExpectedCalls', { operator: MOCK_CALL_COUNT_SYMBOL[operator], count: String(count) })}
      </span>
    </MockCard>
  )
}
