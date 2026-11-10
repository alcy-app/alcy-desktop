import { parseTabGroups } from './tab-groups'
import type { TabGroup } from './tab-groups'
import type { TabSessionEnvelope } from '../../bindings/save-tab-session'
import { emptyRequestContent, findExample, findRequest } from './collection-tree'
import type { ExampleResponse, RequestContent, TreeNode } from './collection-tree'
import type { ExampleTabState, WorkbenchTab } from './request-workbench.types'

/** A saved session tab (ADR 0039). Drafts contain unsaved edits; clean requests reload from their collection. */
export interface PersistedTab {
  id: string
  requestId: string | null
  name: string
  draft: RequestContent | null
  fixed?: boolean
  /** Example the tab edits; `response` holds unsaved edits and is null when there are none. */
  example?: { exampleId: string; response: ExampleResponse | null }
}

export interface TabSession {
  activeTabId: string | null
  tabs: PersistedTab[]
  groups?: TabGroup[]
}

/** Resolved editor content and its saved baseline for the unsaved indicator. */
export interface RestoredTab {
  id: string
  requestId: string | null
  name: string
  content: RequestContent
  savedContent: RequestContent
  fixed: boolean
  example?: { requestId: string; state: ExampleTabState }
}

/** Recover request tabs; history previews are ephemeral and inline requests belong to their flow. */
function isRecoverable(tab: WorkbenchTab): boolean {
  if (tab.flowNodeRef) return false
  return tab.pinned || tab.requestId !== null || tab.example !== undefined
}

export function snapshotTabSession(
  tabs: WorkbenchTab[],
  activeTabId: string | null,
  contentOf: (tab: WorkbenchTab) => RequestContent,
  groups: readonly TabGroup[] = [],
): TabSessionEnvelope {
  const recoverable = tabs.filter(isRecoverable)
  const persistedGroups = parseTabGroups(groups, new Set(recoverable.filter((tab) => !tab.fixed).map((tab) => tab.id)))
  return {
    version: 1,
    activeTabId: recoverable.some((tab) => tab.id === activeTabId) ? activeTabId : null,
    tabs: recoverable.map(
      (tab): PersistedTab => ({
        id: tab.id,
        requestId: tab.requestId,
        name: tab.name,
        // Tabs without a saved request need a content snapshot even when promoted from a clean preview.
        draft: tab.dirty || (tab.requestId === null && !tab.example) ? contentOf(tab) : null,
        ...(tab.fixed ? { fixed: true } : {}),
        ...(tab.example ? { example: { exampleId: tab.example.exampleId, response: tab.dirty ? tab.example.response : null } } : {}),
      }),
    ),
    ...(persistedGroups.length ? { groups: persistedGroups } : {}),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasStrings = (value: Record<string, unknown>, keys: string[]) =>
  keys.every((key) => typeof value[key] === 'string')

const isNameValueList = (value: unknown, extra: string[] = []) =>
  Array.isArray(value) && value.every((item) => isRecord(item) && hasStrings(item, ['name', ...extra]))

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options'])
const RAW_LANGUAGES = new Set(['text', 'javascript', 'json', 'html', 'xml'])

const AUTHENTICATION_FIELDS: Record<string, string[]> = {
  none: [],
  inherit: [],
  customHeader: ['name', 'value'],
  bearer: ['token'],
  basic: ['username', 'password'],
  digest: ['username', 'password'],
  oauth2ClientCredentials: ['clientId', 'clientSecret', 'tokenUrl', 'scope'],
}

function isValidBody(body: unknown): boolean {
  if (!isRecord(body) || typeof body.type !== 'string') return false
  switch (body.type) {
    case 'none':
      return true
    case 'raw':
      return hasStrings(body, ['content', 'rawLanguage']) && RAW_LANGUAGES.has(body.rawLanguage as string)
    case 'binary':
      return hasStrings(body, ['filePath'])
    case 'urlencoded':
      return (
        isNameValueList(body.fields, ['value']) &&
        (body.fields as Record<string, unknown>[]).every((field) => typeof field.enabled === 'boolean')
      )
    case 'formData':
      return (
        Array.isArray(body.fields) &&
        body.fields.every((field) => {
          if (!isRecord(field) || !hasStrings(field, ['name']) || typeof field.enabled !== 'boolean') return false
          if (field.kind === 'text') return typeof field.value === 'string'
          if (field.kind === 'file') return typeof field.filePath === 'string'
          return false
        })
      )
    default:
      return false
  }
}

function isValidAuthentication(authentication: unknown): boolean {
  if (!isRecord(authentication) || typeof authentication.type !== 'string') return false
  const fields = AUTHENTICATION_FIELDS[authentication.type]
  return fields !== undefined && hasStrings(authentication, fields)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** A saved gRPC call (spec 0129): every field of `GrpcCallState`, well formed. */
function isValidGrpcCall(grpc: unknown): grpc is RequestContent['grpc'] {
  if (!isRecord(grpc) || !hasStrings(grpc, ['service', 'method', 'message'])) return false
  if (grpc.deadlineMs !== null && typeof grpc.deadlineMs !== 'number') return false
  const source = grpc.schemaSource
  if (!isRecord(source)) return false
  if (source.type === 'reflection') return true
  return source.type === 'protoFiles' && isStringList(source.files) && isStringList(source.importPaths)
}

/** A saved WebSocket call (spec 0140), well formed. */
function isValidWebSocketCall(websocket: unknown): websocket is NonNullable<RequestContent['websocket']> {
  if (!isRecord(websocket) || !hasStrings(websocket, ['message'])) return false
  if (!['text', 'json', 'binary'].includes(websocket.messageFormat as string)) return false
  if (!isStringList(websocket.subprotocols)) return false
  const optionalNumber = (value: unknown) => value === null || typeof value === 'number'
  return optionalNumber(websocket.waitMs) && optionalNumber(websocket.expectedMessages)
}

/** Fill missing additive fields with protocol defaults; reject malformed existing fields. */
function parseContent(raw: unknown): RequestContent | null {
  if (
    !isRecord(raw) ||
    (raw.protocol !== 'rest' && raw.protocol !== 'graphql' && raw.protocol !== 'grpc' && raw.protocol !== 'websocket')
  ) {
    return null
  }
  const content = { ...emptyRequestContent(raw.protocol) }
  const merged = { ...content, ...raw } as Record<string, unknown>

  const stringKeys = ['endpointUrl', 'query', 'variables', 'method', 'preRequestScript', 'postResponseScript']
  if (!hasStrings(merged, stringKeys)) return null
  if (!HTTP_METHODS.has(merged.method as string)) return null
  if (!isNameValueList(merged.headers, ['value']) || !isNameValueList(merged.routeParams, ['value'])) return null
  if (!(merged.headers as Record<string, unknown>[]).every((header) => typeof header.enabled === 'boolean')) return null
  if (!isValidBody(merged.body) || !isValidAuthentication(merged.authentication)) return null
  if (!isValidGrpcCall(merged.grpc)) return null
  if (merged.websocket !== undefined && !isValidWebSocketCall(merged.websocket)) return null

  return {
    protocol: raw.protocol,
    endpointUrl: merged.endpointUrl as string,
    query: merged.query as string,
    variables: merged.variables as string,
    method: merged.method as RequestContent['method'],
    body: merged.body as RequestContent['body'],
    headers: merged.headers as RequestContent['headers'],
    routeParams: merged.routeParams as RequestContent['routeParams'],
    authentication: merged.authentication as RequestContent['authentication'],
    preRequestScript: merged.preRequestScript as string,
    postResponseScript: merged.postResponseScript as string,
    grpc: merged.grpc,
    ...(merged.websocket !== undefined ? { websocket: merged.websocket as RequestContent['websocket'] } : {}),
  }
}

function parseExampleResponse(raw: unknown): ExampleResponse | null {
  if (!isRecord(raw) || !hasStrings(raw, ['body', 'language']) || typeof raw.statusCode !== 'number') return null
  if (!RAW_LANGUAGES.has(raw.language as string) || !isNameValueList(raw.headers, ['value'])) return null
  if (!(raw.headers as Record<string, unknown>[]).every((header) => typeof header.enabled === 'boolean')) return null
  return raw as unknown as ExampleResponse
}

/** An example reference; a malformed one makes the tab unrecoverable rather than a plain draft. */
function parseExampleRef(raw: unknown): PersistedTab['example'] | null {
  if (!isRecord(raw) || typeof raw.exampleId !== 'string' || raw.exampleId === '') return null
  if (raw.response === null || raw.response === undefined) return { exampleId: raw.exampleId, response: null }
  const response = parseExampleResponse(raw.response)
  return response === null ? null : { exampleId: raw.exampleId, response }
}

function parseTab(raw: unknown): PersistedTab | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id === '') return null
  const requestId = typeof raw.requestId === 'string' && raw.requestId !== '' ? raw.requestId : null
  const name = typeof raw.name === 'string' ? raw.name : ''
  const fixed = raw.fixed === true ? { fixed: true } : {}
  const parsedExample = raw.example === undefined ? undefined : parseExampleRef(raw.example)
  if (parsedExample === null) return null
  const extras = { ...fixed, ...(parsedExample ? { example: parsedExample } : {}) }
  if (raw.draft === null || raw.draft === undefined) {
    // Only saved requests and examples can reload content without a draft.
    return requestId === null && !parsedExample ? null : { id: raw.id, requestId, name, draft: null, ...extras }
  }
  const draft = parseContent(raw.draft)
  return draft === null ? null : { id: raw.id, requestId, name, draft, ...extras }
}

/** Parse native session data, discarding invalid or duplicate tabs independently. */
export function parseTabSession(raw: unknown): TabSession | null {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.tabs)) return null
  const seen = new Set<string>()
  const tabs: PersistedTab[] = []
  for (const candidate of raw.tabs) {
    const tab = parseTab(candidate)
    if (tab === null || seen.has(tab.id)) continue
    seen.add(tab.id)
    tabs.push(tab)
  }
  const activeTabId = typeof raw.activeTabId === 'string' && seen.has(raw.activeTabId) ? raw.activeTabId : null
  const groups = parseTabGroups(raw.groups, new Set(tabs.filter((tab) => !tab.fixed).map((tab) => tab.id)))
  return { activeTabId, tabs, ...(groups.length ? { groups } : {}) }
}

/** Resolve against current collections; retain edits to removed requests as independent drafts. */
export function resolveTabSession(session: TabSession, collections: TreeNode[]): RestoredTab[] {
  return session.tabs.flatMap((tab): RestoredTab[] => {
    if (tab.example) {
      const found = findExample(collections, tab.example.exampleId)
      if (!found) return []
      const { exampleId } = tab.example
      const savedResponse = found.example.response
      return [
        {
          id: tab.id,
          requestId: null,
          name: found.example.name,
          content: tab.draft ?? found.example.content,
          savedContent: found.example.content,
          fixed: tab.fixed === true,
          example: {
            requestId: found.request.id,
            state: { exampleId, response: tab.example.response ?? savedResponse, savedResponse },
          },
        },
      ]
    }

    const saved = tab.requestId === null ? null : findRequest(collections, tab.requestId)

    if (saved) {
      return [
        {
          id: tab.id,
          requestId: saved.id,
          name: saved.name,
          content: tab.draft ?? saved.content,
          savedContent: saved.content,
          fixed: tab.fixed === true,
        },
      ]
    }
    if (tab.draft === null) return []
    return [{ id: tab.id, requestId: null, name: tab.name, content: tab.draft, savedContent: tab.draft, fixed: tab.fixed === true }]
  })
}

/** Migrate the legacy localStorage list of saved request IDs. */
export function sessionFromLegacy(legacy: { openRequestIds: string[]; activeRequestId: string | null }): TabSession {
  const tabs = legacy.openRequestIds.map((requestId) => ({ id: crypto.randomUUID(), requestId, name: '', draft: null }))
  const active = tabs.find((tab) => tab.requestId === legacy.activeRequestId)
  return { activeTabId: active?.id ?? null, tabs }
}
