import { invoke } from '@tauri-apps/api/core'

export interface MockHeaderDto { name: string; value: string }
export type MockConditionDto =
  | { kind: 'group'; group: MockConditionGroupDto }
  | { kind: 'match'; source: 'pathParameter' | 'query' | 'header' | 'bodyText' | 'jsonPointer'; key: string; operator: 'equals' | 'notEquals' | 'contains' | 'exists' | 'notExists'; value: string }
export interface MockConditionGroupDto { operator: 'all' | 'any'; conditions: MockConditionDto[] }
export interface MockResponseDto { id: string; name: string; enabled: boolean; status: number; headers: MockHeaderDto[]; body: string; delayMs: number; condition: MockConditionGroupDto | null }
export interface MockRouteDto { id: string; name: string; enabled: boolean; method: string; path: string; defaultResponse: MockResponseDto; alternatives: MockResponseDto[] }
export interface MockServerDto { id: string; name: string; port: number; corsEnabled: boolean; routes: MockRouteDto[] }
export interface MockServerSummaryDto { id: string; name: string; port: number; running: boolean; routesCount: number }
export type MockServersError = { kind: 'invalid' | 'storage'; message: string } | { kind: 'notFound' }
type Result<T> = { ok: true; value: T } | { ok: false; error: MockServersError }
async function call<T>(command: string, input: unknown): Promise<Result<T>> { try { return { ok: true, value: await invoke<T>(command, { input }) } } catch (error) { return { ok: false, error: error as MockServersError } } }
export const listMockServers = (rootPath: string) => call<{ servers: MockServerSummaryDto[] }>('list_mock_servers', { rootPath })
export const getMockServer = (rootPath: string, serverId: string) => call<MockServerDto>('get_mock_server', { rootPath, serverId })
export const saveMockServer = (rootPath: string, server: MockServerDto) => call<void>('save_mock_server', { rootPath, server })
export const validateMockServer = (server: MockServerDto) => call<void>('validate_mock_server', { server })
export const deleteMockServer = (rootPath: string, serverId: string) => call<void>('delete_mock_server', { rootPath, serverId })
export const startMockServer = (rootPath: string, serverId: string) => call<void>('start_mock_server', { rootPath, serverId })
export const stopMockServer = (rootPath: string, serverId: string) => call<void>('stop_mock_server', { rootPath, serverId })
export interface MockCallLogDto { id: number; method: string; path: string; routeId: string | null; routeName: string | null; responseName: string | null; status: number; durationMs: number }
export const listMockCalls = (serverId: string, offset = 0, limit = 100) => call<MockCallLogDto[]>('list_mock_calls', { serverId, offset, limit })
export const clearMockCalls = (rootPath: string, serverId: string) => call<void>('clear_mock_calls', { rootPath, serverId })
