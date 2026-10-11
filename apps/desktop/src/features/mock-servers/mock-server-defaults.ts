import type { MockResponseDto, MockRouteDto, MockServerDto } from '../../bindings/mock-servers'
import type { TranslationKey, TranslationParams } from '../../shared/i18n/translations'

type Translate = (key: TranslationKey, params?: TranslationParams) => string

export const MOCK_SERVERS_CHANGED_EVENT = 'alcy:mock-servers-changed'

export function newMockResponse(name: string): MockResponseDto {
  return {
    id: crypto.randomUUID(), name, enabled: true, status: 200,
    headers: [{ name: 'content-type', value: 'application/json' }],
    body: '{\n  \n}', delayMs: 0, condition: null,
  }
}

export function newMockRoute(t: Translate): MockRouteDto {
  return {
    id: crypto.randomUUID(), name: t('mockServers.defaultRouteName'), enabled: true, method: 'GET', path: '/',
    defaultResponse: newMockResponse(t('mockServers.defaultResponseName')), alternatives: [],
  }
}

export function newMockServer(port: number, t: Translate): MockServerDto {
  return { id: crypto.randomUUID(), name: t('mockServers.defaultServerName'), port, corsEnabled: true, routes: [newMockRoute(t)] }
}

/** Mensagens `invalid`/`storage` vêm prontas do backend. */
export function mockErrorMessage(error: { kind: string; message?: string }, t: Translate): string {
  return error.kind === 'notFound' ? t('mockServers.error.notFound') : (error.message ?? t('mockServers.error.generic'))
}
