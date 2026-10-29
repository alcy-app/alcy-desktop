import type { AuthenticationInput, HeaderInput } from '../../bindings/execute-graphql-request'
import type { HttpMethodInput, RawBodyLanguage, RestBodyInput } from '../../bindings/execute-rest-request'
import { emptyRequestContent, findNode, findRequest, type RequestContent, type TreeNode } from '../request-workbench/collection-tree'
import type { ExecutionState } from '../request-workbench/request-workbench.types'
import type { EditorField } from '../request-workbench/editor-bridge'
import type { AgentHostTab, WorkbenchAgentHost } from './agent-host'

/** Stands for a secret the model never sees. Writing it back keeps the secret. */
export const AGENT_SECRET_MASK = '••••'

const MAX_BODY_CHARS = 16 * 1024
const MAX_HEADERS = 40
const MAX_SEARCH_RESULTS = 50
const DEFAULT_SEARCH_RESULTS = 20
const METHODS: HttpMethodInput[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']
const RAW_LANGUAGES: RawBodyLanguage[] = ['json', 'text', 'xml', 'html', 'javascript']
const EDITOR_FIELDS: EditorField[] = ['body', 'query', 'variables', 'preRequestScript', 'postResponseScript']
const SECRET_HEADER = /authorization|token|secret|api[-_]?key|cookie|password|session/i
const TEMPLATE_ONLY = /^\s*\{\{[^{}]+\}\}\s*$/

export interface AgentToolOutcome {
  content: string
  isError: boolean
  /** Undoes an `edit` tool's change to a tab. */
  revert?: () => void
}

class ToolInputError extends Error {}

type Input = Record<string, unknown>

function ok(value: unknown, revert?: () => void): AgentToolOutcome {
  return { content: JSON.stringify(value), isError: false, revert }
}

function failure(message: string): AgentToolOutcome {
  return { content: message, isError: true }
}

function optionalString(input: Input, key: string): string | undefined {
  const value = input[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ToolInputError(`'${key}' must be a string.`)
  return value
}

function requiredString(input: Input, key: string): string {
  const value = optionalString(input, key)
  if (value === undefined || value.trim() === '') throw new ToolInputError(`'${key}' is required.`)
  return value
}

/** Secret values are hidden unless they only reference a variable. */
function maskSecret(value: string): string {
  if (value === '' || TEMPLATE_ONLY.test(value)) return value
  return AGENT_SECRET_MASK
}

function maskHeaders(headers: { name: string; value: string; enabled?: boolean }[]) {
  return headers.slice(0, MAX_HEADERS).map((header) => ({
    ...header,
    value: SECRET_HEADER.test(header.name) ? maskSecret(header.value) : header.value,
  }))
}

function maskAuthentication(auth: AuthenticationInput): Record<string, unknown> {
  switch (auth.type) {
    case 'none':
    case 'inherit':
      return { type: auth.type }
    case 'bearer':
      return { type: 'bearer', token: maskSecret(auth.token) }
    case 'basic':
    case 'digest':
      return { type: auth.type, username: auth.username, password: maskSecret(auth.password) }
    case 'customHeader':
      return { type: 'customHeader', name: auth.name, value: maskSecret(auth.value) }
    case 'oauth2ClientCredentials':
      return { type: auth.type, clientId: auth.clientId, clientSecret: maskSecret(auth.clientSecret), tokenUrl: auth.tokenUrl, scope: auth.scope }
  }
}

function truncate(text: string, max = MAX_BODY_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated: ${text.length - max} more characters]`
}

function describeBody(body: RestBodyInput): Record<string, unknown> {
  switch (body.type) {
    case 'none':
      return { type: 'none' }
    case 'raw':
      return { type: 'raw', language: body.rawLanguage, content: truncate(body.content) }
    case 'urlencoded':
      return { type: 'urlencoded', fields: body.fields }
    case 'formData':
      return { type: 'formData', fields: body.fields.map((field) => ({ name: field.name, kind: field.kind, enabled: field.enabled })) }
    case 'binary':
      return { type: 'binary', file: body.filePath }
  }
}

/** The request without secrets, as the model reads it. */
export function describeRequest(content: RequestContent): Record<string, unknown> {
  const base: Record<string, unknown> = {
    protocol: content.protocol,
    url: content.endpointUrl,
    headers: maskHeaders(content.headers),
    authentication: maskAuthentication(content.authentication),
  }
  if (content.protocol === 'rest') {
    base.method = content.method
    base.body = describeBody(content.body)
  } else if (content.protocol === 'graphql') {
    base.query = truncate(content.query)
    base.variables = truncate(content.variables)
  } else {
    base.grpc = { service: content.grpc.service, method: content.grpc.method }
  }
  base.preRequestScript = truncate(content.preRequestScript)
  base.postResponseScript = truncate(content.postResponseScript)
  return base
}

function describeTab(tab: AgentHostTab, activeTabId: string | null) {
  return {
    tabId: tab.id,
    name: tab.name,
    protocol: tab.protocol,
    method: tab.protocol === 'rest' ? tab.content.method : undefined,
    url: tab.content.endpointUrl,
    savedRequestId: tab.requestId,
    unsaved: tab.dirty,
    active: tab.id === activeTabId,
    hasResponse: tab.execution.status === 'success' || tab.execution.status === 'error',
  }
}

/** Status, headers and the start of the body; secrets in headers are masked. */
export function describeExecution(execution: ExecutionState): Record<string, unknown> {
  switch (execution.status) {
    case 'idle':
      return { status: 'notSent' }
    case 'loading':
      return { status: 'sending' }
    case 'error': {
      const { error } = execution
      return { status: 'failed', error: { kind: error.kind, message: 'message' in error ? error.message : undefined } }
    }
    case 'success': {
      const { result } = execution
      if (!('statusCode' in result)) {
        return { status: 'completed', grpcMessages: result.messageCount }
      }
      const body =
        result.bodyEncoding === 'base64'
          ? `[binary body, ${result.sizeBytes} bytes]`
          : result.body.kind === 'inline'
            ? truncate(result.body.body)
            : truncate(result.body.preview) + `\n[the full body has ${result.body.totalBytes} bytes]`
      return {
        status: 'completed',
        statusCode: result.statusCode,
        durationMs: result.durationMs,
        sizeBytes: result.sizeBytes,
        headers: maskHeaders(result.headers),
        body: execution.responseNotStored ? '[the body of this response was not kept]' : body,
        graphqlErrors: 'graphqlErrors' in result && result.graphqlErrors.length > 0 ? result.graphqlErrors.slice(0, 20) : undefined,
        tests:
          result.testResults.length > 0
            ? result.testResults.slice(0, 30).map((test) => ({ name: test.name, passed: test.passed }))
            : undefined,
      }
    }
  }
}

function parseHeaders(value: unknown, previous: HeaderInput[]): HeaderInput[] {
  if (!Array.isArray(value)) throw new ToolInputError("'headers' must be a list.")
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new ToolInputError(`headers[${index}] must be an object.`)
    const { name, value: headerValue, enabled } = entry as Input
    if (typeof name !== 'string' || typeof headerValue !== 'string') throw new ToolInputError(`headers[${index}] needs name and value.`)
    const kept = headerValue === AGENT_SECRET_MASK ? (previous.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? '') : headerValue
    return { name, value: kept, enabled: typeof enabled === 'boolean' ? enabled : true }
  })
}

function parseBody(value: unknown, previous: RestBodyInput): RestBodyInput {
  if (typeof value !== 'object' || value === null) throw new ToolInputError("'body' must be an object.")
  const body = value as Input
  switch (body.type) {
    case 'none':
      return { type: 'none' }
    case 'raw': {
      const language = optionalString(body, 'language')
      if (language !== undefined && !RAW_LANGUAGES.includes(language as RawBodyLanguage)) throw new ToolInputError(`Unknown body language '${language}'.`)
      return {
        type: 'raw',
        content: optionalString(body, 'content') ?? '',
        rawLanguage: (language as RawBodyLanguage | undefined) ?? (previous.type === 'raw' ? previous.rawLanguage : 'json'),
      }
    }
    case 'urlencoded': {
      const fields = Array.isArray(body.fields) ? body.fields : []
      return {
        type: 'urlencoded',
        fields: fields.map((field) => {
          const entry = (field ?? {}) as Input
          return { name: String(entry.name ?? ''), value: String(entry.value ?? ''), enabled: true }
        }),
      }
    }
    default:
      throw new ToolInputError("body.type must be 'none', 'raw' or 'urlencoded'.")
  }
}

function keepSecret(next: string | undefined, previous: string): string {
  return next === undefined || next === AGENT_SECRET_MASK ? previous : next
}

function parseAuthentication(value: unknown, previous: AuthenticationInput): AuthenticationInput {
  if (typeof value !== 'object' || value === null) throw new ToolInputError("'authentication' must be an object.")
  const auth = value as Input
  switch (auth.type) {
    case 'inherit':
    case 'none':
      return { type: auth.type }
    case 'bearer':
      return { type: 'bearer', token: keepSecret(optionalString(auth, 'token'), previous.type === 'bearer' ? previous.token : '') }
    case 'basic':
      return {
        type: 'basic',
        username: optionalString(auth, 'username') ?? (previous.type === 'basic' ? previous.username : ''),
        password: keepSecret(optionalString(auth, 'password'), previous.type === 'basic' ? previous.password : ''),
      }
    case 'customHeader':
      return {
        type: 'customHeader',
        name: optionalString(auth, 'name') ?? (previous.type === 'customHeader' ? previous.name : ''),
        value: keepSecret(optionalString(auth, 'value'), previous.type === 'customHeader' ? previous.value : ''),
      }
    default:
      throw new ToolInputError('authentication.type must be inherit, none, bearer, basic or customHeader.')
  }
}

/** Applies the request fields of `new_request_tab`/`update_request`. */
export function applyRequestPatch(content: RequestContent, input: Input): RequestContent {
  const next: RequestContent = { ...content }
  const method = optionalString(input, 'method')
  if (method !== undefined) {
    const normalized = method.toLowerCase() as HttpMethodInput
    if (!METHODS.includes(normalized)) throw new ToolInputError(`Unknown method '${method}'.`)
    next.method = normalized
  }
  const url = optionalString(input, 'url')
  if (url !== undefined) next.endpointUrl = url.trim()
  if (input.headers !== undefined) next.headers = parseHeaders(input.headers, content.headers)
  if (input.body !== undefined) {
    if (content.protocol !== 'rest') throw new ToolInputError('Only REST requests have a body; use query and variables for GraphQL.')
    next.body = parseBody(input.body, content.body)
  }
  const query = optionalString(input, 'query')
  const variables = optionalString(input, 'variables')
  if ((query !== undefined || variables !== undefined) && content.protocol !== 'graphql') {
    throw new ToolInputError('query and variables only apply to GraphQL requests.')
  }
  if (query !== undefined) next.query = query
  if (variables !== undefined) next.variables = variables
  if (input.authentication !== undefined) next.authentication = parseAuthentication(input.authentication, content.authentication)
  const preRequestScript = optionalString(input, 'preRequestScript')
  const postResponseScript = optionalString(input, 'postResponseScript')
  if (preRequestScript !== undefined) next.preRequestScript = preRequestScript
  if (postResponseScript !== undefined) next.postResponseScript = postResponseScript
  return next
}

function targetTab(host: WorkbenchAgentHost, input: Input): AgentHostTab {
  const tabId = optionalString(input, 'tabId') ?? host.activeTabId()
  const tab = host.tabs().find((candidate) => candidate.id === tabId)
  if (!tab) throw new ToolInputError(tabId ? `No open tab '${tabId}'. Use list_open_tabs.` : 'No tab is open.')
  return tab
}

interface SearchHit {
  kind: 'collection' | 'folder' | 'request'
  id: string
  name: string
  path: string
  method?: string
  url?: string
}

function searchCollections(nodes: TreeNode[], query: string, limit: number): SearchHit[] {
  const needle = query.trim().toLowerCase()
  const hits: SearchHit[] = []
  const visit = (node: TreeNode, path: string[], depth: number) => {
    if (hits.length >= limit) return
    const nodePath = [...path, node.name]
    if (needle === '' ? depth === 0 : node.name.toLowerCase().includes(needle)) {
      hits.push({ kind: depth === 0 ? 'collection' : 'folder', id: node.id, name: node.name, path: nodePath.join(' / ') })
    }
    if (needle === '') return
    for (const request of node.requests) {
      if (hits.length >= limit) return
      const method = request.protocol === 'rest' ? request.content.method.toUpperCase() : request.protocol
      const haystack = `${request.name} ${request.content.endpointUrl} ${method}`.toLowerCase()
      if (haystack.includes(needle)) {
        hits.push({ kind: 'request', id: request.id, name: request.name, path: nodePath.join(' / '), method, url: request.content.endpointUrl })
      }
    }
    for (const folder of node.folders) visit(folder, nodePath, depth + 1)
  }
  for (const node of nodes) visit(node, [], 0)
  return hits
}

function environmentId(host: WorkbenchAgentHost, input: Input): string {
  const id = optionalString(input, 'environmentId') ?? host.activeEnvironmentId()
  if (!id) throw new ToolInputError('There is no active environment; pass environmentId from list_environments.')
  if (!host.environments().some((environment) => environment.id === id)) throw new ToolInputError(`No environment '${id}'.`)
  return id
}

async function run(name: string, input: Input, host: WorkbenchAgentHost, defaultRequestName: string): Promise<AgentToolOutcome> {
  switch (name) {
    case 'list_open_tabs': {
      const active = host.activeTabId()
      return ok({ tabs: host.tabs().map((tab) => describeTab(tab, active)) })
    }
    case 'get_request': {
      const requestId = optionalString(input, 'requestId')
      if (requestId !== undefined && input.tabId === undefined) {
        const request = findRequest(host.collections(), requestId)
        if (!request) return failure(`No saved request '${requestId}'. Use search_collections.`)
        return ok({ requestId, name: request.name, ...describeRequest(request.content) })
      }
      const tab = targetTab(host, input)
      return ok({ tabId: tab.id, name: tab.name, savedRequestId: tab.requestId, unsaved: tab.dirty, ...describeRequest(tab.content) })
    }
    case 'get_response': {
      const tab = targetTab(host, input)
      return ok({ tabId: tab.id, ...describeExecution(tab.execution) })
    }
    case 'search_collections': {
      const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(input.limit))) : DEFAULT_SEARCH_RESULTS
      return ok({ results: searchCollections(host.collections(), optionalString(input, 'query') ?? '', limit) })
    }
    case 'list_environments': {
      const active = host.activeEnvironmentId()
      return ok({
        activeEnvironmentId: active,
        environments: host.environments().map((environment) => ({
          id: environment.id,
          name: environment.name,
          active: environment.id === active,
          variables: environment.variables.map((variable) =>
            variable.sensitive ? { name: variable.name, sensitive: true } : { name: variable.name, value: truncate(variable.value, 500) },
          ),
        })),
      })
    }
    case 'open_request': {
      const tabId = await host.openRequest(requiredString(input, 'requestId'))
      return tabId ? ok({ tabId }) : failure('No saved request with that id. Use search_collections.')
    }
    case 'select_tab': {
      const tabId = requiredString(input, 'tabId')
      return (await host.selectTab(tabId)) ? ok({ tabId }) : failure(`No open tab '${tabId}'.`)
    }
    case 'close_tab': {
      const tabId = requiredString(input, 'tabId')
      return (await host.closeTab(tabId)) ? ok({ closedTabId: tabId }) : failure(`No open tab '${tabId}'.`)
    }
    case 'highlight_in_editor': {
      const tab = targetTab(host, input)
      const target = optionalString(input, 'target')
      if (target !== 'request' && target !== 'response') throw new ToolInputError("target must be 'request' or 'response'.")
      const field = optionalString(input, 'field')
      if (field !== undefined && !EDITOR_FIELDS.includes(field as EditorField)) throw new ToolInputError(`Unknown field '${field}'.`)
      if (field !== undefined && target === 'response') throw new ToolInputError('field only applies to the request.')
      const text = requiredString(input, 'text')
      const result = await host.highlight(tab.id, target, (field as EditorField | undefined) ?? null, text)
      if (result.ok) return ok({ tabId: tab.id, editor: result.slot, matches: result.matches })
      const reasons = {
        notFound: 'The tab no longer exists.',
        noResponse: 'This tab has no response yet; send the request first.',
        noEditor: 'That content is not shown in a text editor (e.g. HTML preview or a binary body).',
        noMatch: `'${text}' does not appear there. Check the exact text with get_request or get_response.`,
      }
      return failure(reasons[result.reason])
    }
    case 'new_request_tab': {
      const protocol = optionalString(input, 'protocol')
      if (protocol !== 'rest' && protocol !== 'graphql') throw new ToolInputError("protocol must be 'rest' or 'graphql'.")
      const content = applyRequestPatch(emptyRequestContent(protocol), input)
      const tabId = await host.newRequestTab(optionalString(input, 'name')?.trim() || defaultRequestName, content)
      return tabId ? ok({ tabId }) : failure('The tab could not be opened.')
    }
    case 'update_request': {
      const tab = targetTab(host, input)
      const previous = tab.content
      const next = applyRequestPatch(previous, input)
      host.replaceContent(tab.id, next)
      return ok({ tabId: tab.id, ...describeRequest(next) }, () => host.replaceContent(tab.id, previous))
    }
    case 'send_request': {
      const tab = targetTab(host, input)
      const execution = await host.send(tab.id)
      if (!execution) return failure('The request could not be sent.')
      return ok({ tabId: tab.id, ...describeExecution(execution) })
    }
    case 'save_request': {
      const tab = targetTab(host, input)
      const parentId = optionalString(input, 'parentId')
      const target = tab.requestId === null && parentId !== undefined ? { parentId, name: optionalString(input, 'name')?.trim() || tab.name } : null
      const result = await host.saveTab(tab.id, target)
      if (result.ok) return ok({ tabId: tab.id, requestId: result.requestId, name: result.name })
      const reasons = {
        notFound: 'The tab no longer exists.',
        flowNode: 'This tab belongs to a flow node; the user saves it from the flow.',
        needsParent: 'This draft has no collection yet: pass parentId (a collection or folder id from search_collections).',
        unknownParent: 'parentId is not a collection or folder.',
      }
      return failure(reasons[result.reason])
    }
    case 'create_collection':
      return ok({ collectionId: host.createCollection(requiredString(input, 'name').trim()) })
    case 'create_folder': {
      const parentId = requiredString(input, 'parentId')
      if (!findNode(host.collections(), parentId)) return failure('parentId is not a collection or folder.')
      const folderId = host.createFolder(parentId, requiredString(input, 'name').trim())
      return folderId ? ok({ folderId }) : failure('The folder could not be created.')
    }
    case 'set_environment_variable': {
      const id = environmentId(host, input)
      const variableName = requiredString(input, 'name').trim()
      const value = optionalString(input, 'value') ?? ''
      if (value === AGENT_SECRET_MASK) return failure('That is the mask of a secret, not its value; leave the variable as it is.')
      const sensitive = typeof input.sensitive === 'boolean' ? input.sensitive : undefined
      host.setVariable(id, variableName, value, sensitive)
      return ok({ environmentId: id, name: variableName })
    }
    case 'set_active_environment': {
      const id = input.environmentId
      if (id !== null && typeof id !== 'string') throw new ToolInputError("'environmentId' must be a string or null.")
      if (id !== null && !host.environments().some((environment) => environment.id === id)) return failure(`No environment '${id}'.`)
      host.setActiveEnvironment(id)
      return ok({ activeEnvironmentId: id })
    }
    default:
      return failure(`Unknown tool '${name}'.`)
  }
}

/** Runs a tool on the workbench. Approval of side effects happens before this is called. */
export async function runAgentTool(name: string, input: Input, host: WorkbenchAgentHost, defaultRequestName: string): Promise<AgentToolOutcome> {
  try {
    return await run(name, input, host, defaultRequestName)
  } catch (error) {
    if (error instanceof ToolInputError) return failure(error.message)
    return failure(`The tool failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Tools that need approval only in some cases: closing a tab discards its unsaved changes. */
export function toolNeedsApproval(name: string, input: Input, host: WorkbenchAgentHost): boolean {
  if (name !== 'close_tab') return false
  return host.tabs().some((tab) => tab.id === input.tabId && tab.dirty)
}

/** Short description of a call for its card in the chat. */
export function summarizeToolCall(name: string, input: Input, host: WorkbenchAgentHost | null): string {
  const tab = host?.tabs().find((candidate) => candidate.id === (input.tabId ?? host.activeTabId()))
  const string = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  switch (name) {
    case 'send_request':
      return tab ? `${tab.protocol === 'rest' ? tab.content.method.toUpperCase() : tab.protocol} ${tab.content.endpointUrl || tab.name}` : ''
    case 'save_request':
      return string('name') || tab?.name || ''
    case 'update_request':
    case 'new_request_tab': {
      const fields = Object.keys(input).filter((key) => key !== 'tabId' && key !== 'protocol')
      const head = name === 'new_request_tab' ? [string('method').toUpperCase(), string('url')].filter(Boolean).join(' ') : tab?.name ?? ''
      return [head, fields.length > 0 && name === 'update_request' ? `(${fields.join(', ')})` : ''].filter(Boolean).join(' ')
    }
    case 'search_collections':
      return string('query')
    case 'create_collection':
    case 'create_folder':
      return string('name')
    case 'set_environment_variable':
      return string('name')
    case 'open_request': {
      const request = host ? findRequest(host.collections(), string('requestId')) : null
      return request?.name ?? ''
    }
    case 'highlight_in_editor':
      return string('text')
    case 'get_request':
    case 'get_response':
    case 'select_tab':
    case 'close_tab':
      return tab?.name ?? ''
    default:
      return ''
  }
}
