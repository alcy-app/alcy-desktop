import type { NodeProps } from '@xyflow/react'
import type { ReactNode } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { FlowNodeCard } from './FlowNodeCard'
import type { NodeOutput } from './FlowNodeCard'
import { MOCK_CALL_COUNT_SYMBOL, findMockRoute, mockRouteLabel, mockRouteResponses } from './mock-nodes'
import type { MockStartInfo } from './mock-nodes'
import { formatSleepDuration } from './simple-node-types'
import type { SimpleFlowNodeType, SimpleNodeData } from './simple-node-types'

/** Compact mock overview. Waiting never adds animated layers to the scaled canvas. */
function MockCard({ data, outputs, children }: { data: SimpleNodeData; outputs?: NodeOutput[]; children: ReactNode }) {
  return (
    <FlowNodeCard
      kind={data.config.kind}
      runStatus={data.runStatus}
      visited={data.visited}
      readOnly={data.readOnly}
      outputs={outputs}
      onOpenSettings={data.onOpenSettings}
      onDuplicate={data.onDuplicate}
      onDelete={data.onDelete}
    >
      {children}
    </FlowNodeCard>
  )
}

/** Referenced mock and route, or the missing configuration. */
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
            {' · '}{mockRouteLabel(route)}
          </code>
        ) : (
          <span className="flow-node-placeholder">{t('flows.canvas.mockNoRouteSelected')}</span>
        ))}
    </>
  )
}

export function MockStartNode({ data }: NodeProps<SimpleFlowNodeType>) {
  const { t } = useLanguage()
  if (data.config.kind !== 'mockStart') return null
  const { source } = data.config
  const server = data.mockStart?.server ?? null
  const missing = source.type === 'saved' && source.serverId !== '' && !server

  return (
    <MockCard data={data}>
      <span>{source.type === 'inline' ? source.server.name || t('flows.canvas.mockUnnamedServer') : server ? server.name : t(missing ? 'flows.canvas.mockServerMissing' : 'flows.canvas.mockNoServerSelected')}</span>
      {server && (
        <code className="flow-node-inline-code">
          {' · '}127.0.0.1:{server.port} · {t('flows.canvas.mockRoutesCount', { count: String(server.routes.length) })}
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

export function MockWaitRequestNode({ data }: NodeProps<SimpleFlowNodeType>) {
  const { t } = useLanguage()
  if (data.config.kind !== 'mockWaitRequest') return null
  return (
    <MockCard
      data={data}
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
