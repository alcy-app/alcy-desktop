import type { MockRouteDto, MockServerDto } from '../../bindings/mock-servers'
import type { MockCallCountOperatorState, MockServerSourceState, SimpleNodeKindState } from './flows.types'

/** Mock ligado por um bloco "Ligar mock" (spec 0121), como os demais blocos
 * de mock e o inspector o enxergam. `server` é `null` enquanto um mock salvo
 * não carregou, não foi escolhido ou não existe mais. */
export interface MockStartInfo {
  nodeId: string
  name: string
  inline: boolean
  server: MockServerDto | null
}

/** Blocos "Ligar mock" do canvas, com o mock de cada um resolvido — avulso
 * pelo próprio node, salvo pelo que já foi carregado do workspace. */
export function resolveMockStarts(
  nodes: { id: string; config: SimpleNodeKindState }[],
  savedServers: Record<string, MockServerDto>,
): Record<string, MockStartInfo> {
  const starts: Record<string, MockStartInfo> = {}
  for (const { id, config } of nodes) {
    if (config.kind !== 'mockStart') continue
    const server = resolveSource(config.source, savedServers)
    starts[id] = { nodeId: id, name: server?.name ?? '', inline: config.source.type === 'inline', server }
  }
  return starts
}

function resolveSource(source: MockServerSourceState, savedServers: Record<string, MockServerDto>): MockServerDto | null {
  if (source.type === 'inline') return source.server
  return savedServers[source.serverId] ?? null
}

/** Ids dos mocks salvos usados por blocos "Ligar mock" — os que precisam
 * ser carregados para mostrar rotas e respostas. */
export function savedMockServerIds(configs: SimpleNodeKindState[]): string[] {
  const ids = new Set<string>()
  for (const config of configs) {
    if (config.kind === 'mockStart' && config.source.type === 'saved' && config.source.serverId) ids.add(config.source.serverId)
  }
  return [...ids].sort()
}

/** `MÉTODO /caminho` de uma rota, como o motor descreve nas mensagens do run. */
export function mockRouteLabel(route: Pick<MockRouteDto, 'method' | 'path'>): string {
  return `${route.method} ${route.path}`
}

export function findMockRoute(server: MockServerDto | null, routeId: string): MockRouteDto | null {
  return server?.routes.find((route) => route.id === routeId) ?? null
}

/** Respostas de uma rota que um bloco "Trocar resposta" pode forçar. */
export function mockRouteResponses(route: MockRouteDto): { id: string; name: string }[] {
  return [route.defaultResponse, ...route.alternatives].map((response) => ({ id: response.id, name: response.name }))
}

export const MOCK_CALL_COUNT_SYMBOL: Record<MockCallCountOperatorState, string> = {
  equals: '=',
  atLeast: '≥',
  atMost: '≤',
}

/** Bloco "Ligar mock" que um bloco de mock novo já aponta: o node de onde a
 * conexão saiu, quando é um "Ligar mock", senão o único do flow. */
export function defaultMockStartNodeId(sourceNodeId: string | null, starts: Record<string, MockStartInfo>): string {
  if (sourceNodeId && starts[sourceNodeId]) return sourceNodeId
  const ids = Object.keys(starts)
  return ids.length === 1 ? ids[0] : ''
}
