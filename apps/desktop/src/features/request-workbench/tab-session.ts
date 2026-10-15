import type { TabSessionEnvelope } from '../../bindings/save-tab-session'
import { emptyRequestContent, findRequest } from './collection-tree'
import type { RequestContent, TreeNode } from './collection-tree'
import type { WorkbenchTab } from './request-workbench.types'

/** Uma aba na sessão gravada (ADR 0039). `draft` é o conteúdo em edição quando há alterações não
 * salvas; `null` numa requisição salva sem edições, cujo conteúdo vem da coleção ao restaurar. */
export interface PersistedTab {
  id: string
  requestId: string | null
  name: string
  draft: RequestContent | null
  fixed?: boolean
}

export interface TabSession {
  activeTabId: string | null
  tabs: PersistedTab[]
}

/** Aba pronta para o workbench recriar: `content` é o que aparece no editor e `savedContent` a
 * base de comparação para o indicador de não salvo. */
export interface RestoredTab {
  id: string
  requestId: string | null
  name: string
  content: RequestContent
  savedContent: RequestContent
  fixed: boolean
}

/** Abas que entram na sessão: as de requisição fixadas. Pré-visualizações não fixadas (histórico)
 * são efêmeras, e abas de node de flow gravam no próprio flow. */
function isRecoverable(tab: WorkbenchTab): boolean {
  if (tab.flowNodeRef) return false
  return tab.pinned || tab.requestId !== null
}

export function snapshotTabSession(
  tabs: WorkbenchTab[],
  activeTabId: string | null,
  contentOf: (tab: WorkbenchTab) => RequestContent,
): TabSessionEnvelope {
  const recoverable = tabs.filter(isRecoverable)
  return {
    version: 1,
    activeTabId: recoverable.some((tab) => tab.id === activeTabId) ? activeTabId : null,
    tabs: recoverable.map(
      (tab): PersistedTab => ({
        id: tab.id,
        requestId: tab.requestId,
        name: tab.name,
        draft: tab.dirty ? contentOf(tab) : null,
        ...(tab.fixed ? { fixed: true } : {}),
      }),
    ),
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

/** Conteúdo gravado, completado com os padrões do protocolo para campos ausentes (formato
 * aditivo). `null` se algum campo presente tiver forma inválida. */
function parseContent(raw: unknown): RequestContent | null {
  if (!isRecord(raw) || (raw.protocol !== 'rest' && raw.protocol !== 'graphql' && raw.protocol !== 'grpc')) return null
  const content = { ...emptyRequestContent(raw.protocol) }
  const merged = { ...content, ...raw } as Record<string, unknown>

  const stringKeys = ['endpointUrl', 'query', 'variables', 'method', 'preRequestScript', 'postResponseScript']
  if (!hasStrings(merged, stringKeys)) return null
  if (!HTTP_METHODS.has(merged.method as string)) return null
  if (!isNameValueList(merged.headers, ['value']) || !isNameValueList(merged.routeParams, ['value'])) return null
  if (!(merged.headers as Record<string, unknown>[]).every((header) => typeof header.enabled === 'boolean')) return null
  if (!isValidBody(merged.body) || !isValidAuthentication(merged.authentication)) return null
  if (!isValidGrpcCall(merged.grpc)) return null

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
  }
}

function parseTab(raw: unknown): PersistedTab | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id === '') return null
  const requestId = typeof raw.requestId === 'string' && raw.requestId !== '' ? raw.requestId : null
  const name = typeof raw.name === 'string' ? raw.name : ''
  const fixed = raw.fixed === true ? { fixed: true } : {}
  if (raw.draft === null || raw.draft === undefined) {
    // Sem rascunho só faz sentido para uma requisição salva: o conteúdo vem da coleção.
    return requestId === null ? null : { id: raw.id, requestId, name, draft: null, ...fixed }
  }
  const draft = parseContent(raw.draft)
  return draft === null ? null : { id: raw.id, requestId, name, draft, ...fixed }
}

/** Lê a sessão devolvida pelo backend. Abas inválidas (e ids repetidos) são descartadas uma a
 * uma, sem invalidar as demais. `null` quando não há sessão utilizável. */
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
  return { activeTabId, tabs }
}

/** Resolve a sessão contra as coleções atuais. Uma requisição salva sem edições que não existe mais
 * é descartada; uma com edições volta como rascunho, para a edição não se perder. */
export function resolveTabSession(session: TabSession, collections: TreeNode[]): RestoredTab[] {
  return session.tabs.flatMap((tab): RestoredTab[] => {
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

/** Converte a lista legada do `localStorage` (só ids de requisições salvas) numa sessão. */
export function sessionFromLegacy(legacy: { openRequestIds: string[]; activeRequestId: string | null }): TabSession {
  const tabs = legacy.openRequestIds.map((requestId) => ({ id: crypto.randomUUID(), requestId, name: '', draft: null }))
  const active = tabs.find((tab) => tab.requestId === legacy.activeRequestId)
  return { activeTabId: active?.id ?? null, tabs }
}
