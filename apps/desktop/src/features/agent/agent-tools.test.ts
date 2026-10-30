import { describe, expect, it, vi } from 'vitest'
import { emptyRequestContent, type RequestContent, type TreeNode } from '../request-workbench/collection-tree'
import type { ExecutionState } from '../request-workbench/request-workbench.types'
import type { AgentHostTab, WorkbenchAgentHost } from './agent-host'
import { AGENT_SECRET_MASK, applyRequestPatch, runAgentTool, summarizeToolCall, toolNeedsApproval } from './agent-tools'

function restContent(patch: Partial<RequestContent> = {}): RequestContent {
  return { ...emptyRequestContent('rest'), ...patch }
}

function tab(id: string, content: RequestContent, execution: ExecutionState = { status: 'idle' }): AgentHostTab {
  return { id, name: `Tab ${id}`, protocol: content.protocol, requestId: null, dirty: true, isFlowNode: false, content, execution }
}

function fakeHost(tabs: AgentHostTab[], overrides: Partial<WorkbenchAgentHost> = {}): WorkbenchAgentHost {
  const state = { tabs }
  const collections: TreeNode[] = [
    {
      id: 'c1',
      name: 'Users API',
      folders: [],
      requests: [{ id: 'r1', name: 'List users', protocol: 'rest', content: restContent({ endpointUrl: '{{base}}/users' }) }],
      authentication: { type: 'none' },
      variables: [],
    },
  ]
  return {
    tabs: () => state.tabs,
    activeTabId: () => state.tabs[0]?.id ?? null,
    collections: () => collections,
    environments: () => [
      {
        id: 'e1',
        name: 'Dev',
        variables: [
          { name: 'base', value: 'https://dev.example.com', sensitive: false },
          { name: 'token', value: 'super-secret', sensitive: true },
        ],
      },
      { id: 'e2', name: 'Prod', variables: [{ name: 'base', value: 'https://example.com', sensitive: false }] },
    ],
    activeEnvironmentId: () => 'e1',
    openRequest: vi.fn(async () => 'opened'),
    selectTab: vi.fn(async () => true),
    closeTab: vi.fn(async () => true),
    highlight: vi.fn(async () => ({ ok: true as const, slot: 'body' as const, matches: 2 })),
    newRequestTab: vi.fn(async () => 'new-tab'),
    replaceContent: vi.fn((tabId: string, content: RequestContent) => {
      state.tabs = state.tabs.map((candidate) => (candidate.id === tabId ? { ...candidate, content } : candidate))
    }),
    send: vi.fn(async () => null),
    saveTab: vi.fn(async () => ({ ok: false as const, reason: 'needsParent' as const })),
    importFromText: vi.fn(async () => ({ collectionCount: 1, folderCount: 0, requestCount: 1, environmentCount: 0, collections: [{ id: 'imported', name: 'Imported' }], environments: [], firstRequestId: 'imported-request', scriptCount: 0, warningCount: 0, warnings: [] })),
    createCollection: vi.fn(() => 'c2'),
    createFolder: vi.fn(() => 'f1'),
    setVariable: vi.fn(),
    setActiveEnvironment: vi.fn(),
    ...overrides,
  }
}

const parse = (content: string) => JSON.parse(content) as Record<string, unknown>

describe('runAgentTool', () => {
  it('imports original text silently by default and returns saved ids', async () => {
    const host = fakeHost([])
    const content = 'curl https://example.test/a\ncurl https://example.test/b'
    const outcome = await runAgentTool('import_from_text', { content }, host, 'New request')
    expect(outcome.isError).toBe(false)
    expect(host.importFromText).toHaveBeenCalledWith(content)
    expect(parse(outcome.content)).toMatchObject({ requestCount: 1, firstRequestId: 'imported-request', tabId: null })
    expect(host.openRequest).not.toHaveBeenCalled()
    expect(host.send).not.toHaveBeenCalled()
  })

  it('opens the first imported request only when requested', async () => {
    const host = fakeHost([])
    const outcome = await runAgentTool('import_from_text', { content: 'curl https://example.test', openFirstRequest: true }, host, 'New request')
    expect(host.openRequest).toHaveBeenCalledWith('imported-request')
    expect(parse(outcome.content).tabId).toBe('opened')
  })

  it('does not open a tab for an environment-only import', async () => {
    const host = fakeHost([], { importFromText: vi.fn(async () => ({ collectionCount: 0, folderCount: 0, requestCount: 0, environmentCount: 1, collections: [], environments: [{ id: 'new-env', name: 'Imported' }], firstRequestId: null, scriptCount: 0, warningCount: 0, warnings: [] })) })
    const outcome = await runAgentTool('import_from_text', { content: '{}', openFirstRequest: true }, host, 'New request')
    expect(outcome.isError).toBe(false)
    expect(host.openRequest).not.toHaveBeenCalled()
  })

  it.each([
    {}, { content: '' }, { content: 3 }, { content: 'curl https://example.test', openFirstRequest: 'false' },
    { content: `curl -H 'Authorization: ${AGENT_SECRET_MASK}' https://example.test` },
    { content: '{[agent:truncated]}' },
  ])('rejects invalid or incomplete import arguments before saving: %j', async (input) => {
    const host = fakeHost([])
    const outcome = await runAgentTool('import_from_text', input, host, 'New request')
    expect(outcome.isError).toBe(true)
    expect(host.importFromText).not.toHaveBeenCalled()
    expect(host.openRequest).not.toHaveBeenCalled()
  })

  it('reports import failures without opening tabs or exposing content in the card', async () => {
    const host = fakeHost([], { importFromText: vi.fn(async () => { throw new Error('Unsupported format') }) })
    const input = { content: 'private document content' }
    const outcome = await runAgentTool('import_from_text', input, host, 'New request')
    expect(outcome.isError).toBe(true)
    expect(outcome.content).toContain('Unsupported format')
    expect(host.openRequest).not.toHaveBeenCalled()
    expect(summarizeToolCall('import_from_text', input, host)).not.toContain(input.content)
  })

  it('edits gRPC payloads and supports digest and OAuth credentials without losing masked values', () => {
    const grpc = emptyRequestContent('grpc')
    expect(applyRequestPatch(grpc, { grpc: { service: 'users.Users', method: 'Get', message: '{"id":1}', deadlineMs: 5000 } }).grpc).toMatchObject({ service: 'users.Users', method: 'Get', message: '{"id":1}', deadlineMs: 5000 })
    const rest = restContent({ authentication: { type: 'digest', username: 'user', password: 'stored' } })
    expect(applyRequestPatch(rest, { authentication: { type: 'digest', password: AGENT_SECRET_MASK } }).authentication).toEqual(rest.authentication)
    expect(applyRequestPatch(restContent(), { authentication: { type: 'oauth2ClientCredentials', clientId: 'client', clientSecret: '{{secret}}', tokenUrl: '{{base}}/token', scope: 'read' } }).authentication).toMatchObject({ type: 'oauth2ClientCredentials', clientSecret: '{{secret}}' })
  })

  it('reuses user-selected attachments but rejects arbitrary filesystem paths', () => {
    const content = restContent({ body: { type: 'binary', filePath: '/chosen/body.bin' } })
    expect(applyRequestPatch(content, { body: { type: 'binary', filePath: '/chosen/body.bin' } }).body).toEqual(content.body)
    expect(() => applyRequestPatch(content, { body: { type: 'binary', filePath: '/elsewhere/private.bin' } })).toThrow('Select the file')
    expect(applyRequestPatch(restContent(), { body: { type: 'formData', fields: [{ name: 'name', kind: 'text', value: 'User' }] } }).body).toEqual({ type: 'formData', fields: [{ name: 'name', kind: 'text', value: 'User', enabled: true }] })
  })

  it('controls accepting gRPC streams and rejects stream actions on other protocols', async () => {
    const controlGrpcStream = vi.fn(async () => true)
    const host = fakeHost([tab('grpc', emptyRequestContent('grpc'))], { controlGrpcStream, cancelRequest: vi.fn(async () => true) })
    expect((await runAgentTool('send_grpc_message', {}, host, 'x')).isError).toBe(false)
    expect(controlGrpcStream).toHaveBeenCalledWith('grpc', false)
    expect((await runAgentTool('close_grpc_send', {}, host, 'x')).isError).toBe(false)
    expect(controlGrpcStream).toHaveBeenCalledWith('grpc', true)
    expect((await runAgentTool('cancel_request', {}, host, 'x')).isError).toBe(false)
    expect((await runAgentTool('send_grpc_message', {}, fakeHost([tab('rest', restContent())]), 'x')).isError).toBe(true)
  })

  it('returns useful gRPC output with masked metadata', async () => {
    const execution: ExecutionState = { status: 'success', result: { status: { code: 0, codeName: 'OK', message: '' }, durationMs: 12, sizeBytes: 10, messageCount: 1, body: { kind: 'inline', body: '{"id":1}' }, headers: [{ name: 'Authorization', value: 'private' }], trailers: [] } }
    const host = fakeHost([tab('grpc', emptyRequestContent('grpc'), execution)])
    const result = await runAgentTool('get_response', {}, host, 'x')
    expect(result.content).not.toContain('private')
    expect(parse(result.content)).toMatchObject({ grpcStatus: { codeName: 'OK' }, grpcMessages: 1, body: '{"id":1}' })
  })

  it('masks secrets in requests but keeps variable references', async () => {
    const host = fakeHost([
      tab(
        't1',
        restContent({
          endpointUrl: 'https://api.example.com',
          headers: [
            { name: 'Authorization', value: 'Bearer abc', enabled: true },
            { name: 'X-Api-Key', value: '{{apiKey}}', enabled: true },
            { name: 'Accept', value: 'application/json', enabled: true },
          ],
          authentication: { type: 'bearer', token: 'raw-token' },
        }),
      ),
    ])
    const outcome = await runAgentTool('get_request', {}, host, 'New request')
    expect(outcome.isError).toBe(false)
    expect(outcome.content).not.toContain('raw-token')
    expect(outcome.content).not.toContain('Bearer abc')
    const request = parse(outcome.content)
    expect(request.headers).toEqual([
      { name: 'Authorization', value: AGENT_SECRET_MASK, enabled: true },
      { name: 'X-Api-Key', value: '{{apiKey}}', enabled: true },
      { name: 'Accept', value: 'application/json', enabled: true },
    ])
    expect(request.authentication).toEqual({ type: 'bearer', token: AGENT_SECRET_MASK })
  })

  it('never returns sensitive environment values', async () => {
    const outcome = await runAgentTool('list_environments', {}, fakeHost([]), 'New request')
    expect(outcome.content).not.toContain('super-secret')
    expect(outcome.content).toContain('https://dev.example.com')
  })

  it('updates a tab, keeps secrets written back as the mask and can revert', async () => {
    const original = restContent({
      endpointUrl: 'https://old',
      headers: [{ name: 'Authorization', value: 'Bearer abc', enabled: true }],
      authentication: { type: 'bearer', token: 'raw-token' },
    })
    const host = fakeHost([tab('t1', original)])
    const outcome = await runAgentTool(
      'update_request',
      {
        method: 'POST',
        url: '{{base}}/users',
        headers: [
          { name: 'Authorization', value: AGENT_SECRET_MASK },
          { name: 'Content-Type', value: 'application/json' },
        ],
        body: { type: 'raw', content: '{"name":"Ana"}' },
        authentication: { type: 'bearer', token: AGENT_SECRET_MASK },
      },
      host,
      'New request',
    )
    expect(outcome.isError).toBe(false)
    const updated = host.tabs()[0].content
    expect(updated.method).toBe('post')
    expect(updated.endpointUrl).toBe('{{base}}/users')
    expect(updated.headers[0]).toEqual({ name: 'Authorization', value: 'Bearer abc', enabled: true })
    expect(updated.body).toEqual({ type: 'raw', content: '{"name":"Ana"}', rawLanguage: 'json' })
    expect(updated.authentication).toEqual({ type: 'bearer', token: 'raw-token' })

    outcome.revert?.()
    expect(host.tabs()[0].content).toEqual(original)
  })

  it('rejects fields that do not fit the protocol', async () => {
    const host = fakeHost([tab('t1', emptyRequestContent('graphql'))])
    const outcome = await runAgentTool('update_request', { body: { type: 'none' } }, host, 'New request')
    expect(outcome.isError).toBe(true)
    expect(host.replaceContent).not.toHaveBeenCalled()
  })

  it('creates a draft from the given fields', async () => {
    const host = fakeHost([])
    const outcome = await runAgentTool('new_request_tab', { protocol: 'rest', method: 'get', url: 'https://x/health' }, host, 'New request')
    expect(parse(outcome.content)).toEqual({ tabId: 'new-tab' })
    expect(host.newRequestTab).toHaveBeenCalledWith('New request', expect.objectContaining({ endpointUrl: 'https://x/health', method: 'get' }))
  })

  it('reports the response of a send with secret headers masked', async () => {
    const execution: ExecutionState = {
      status: 'success',
      result: {
        statusCode: 201,
        durationMs: 12,
        sizeBytes: 11,
        body: { kind: 'inline', body: '{"id":"1"}' },
        bodyEncoding: 'text',
        headers: [
          { name: 'Set-Cookie', value: 'session=abc' },
          { name: 'Content-Type', value: 'application/json' },
        ],
        requestHeaders: [],
        cookies: [],
        connection: null,
        finalUrl: null,
        waitingMs: 5,
        environmentChanges: [],
        scopedChanges: [],
        scriptLogs: [],
        scriptError: null,
        testResults: [],
      } as never,
    }
    const host = fakeHost([tab('t1', restContent())], { send: vi.fn(async () => execution) })
    const response = parse((await runAgentTool('send_request', {}, host, 'New request')).content)
    expect(response.statusCode).toBe(201)
    expect(response.body).toBe('{"id":"1"}')
    expect(JSON.stringify(response.headers)).not.toContain('session=abc')
  })

  it('explains what a draft needs to be saved', async () => {
    const outcome = await runAgentTool('save_request', {}, fakeHost([tab('t1', restContent())]), 'New request')
    expect(outcome.isError).toBe(true)
    expect(outcome.content).toContain('parentId')
  })

  it('refuses to store the secret mask as a variable value', async () => {
    const host = fakeHost([])
    const outcome = await runAgentTool('set_environment_variable', { name: 'token', value: AGENT_SECRET_MASK }, host, 'New request')
    expect(outcome.isError).toBe(true)
    expect(host.setVariable).not.toHaveBeenCalled()
  })

  it('changes variables of environments that are not active, by id or name, without switching', async () => {
    const host = fakeHost([])
    expect((await runAgentTool('set_environment_variable', { environmentId: 'e2', name: 'base', value: 'https://new.example.com' }, host, 'New request')).isError).toBe(false)
    expect(host.setVariable).toHaveBeenLastCalledWith('e2', 'base', 'https://new.example.com', undefined)
    expect((await runAgentTool('set_environment_variable', { environmentId: 'prod', name: 'region', value: 'us' }, host, 'New request')).isError).toBe(false)
    expect(host.setVariable).toHaveBeenLastCalledWith('e2', 'region', 'us', undefined)
    expect(host.setActiveEnvironment).not.toHaveBeenCalled()
    const missing = await runAgentTool('set_environment_variable', { environmentId: 'Staging', name: 'base', value: 'x' }, host, 'New request')
    expect(missing).toEqual(expect.objectContaining({ isError: true, content: expect.stringContaining("No environment 'Staging'") }))
    expect(summarizeToolCall('set_environment_variable', { environmentId: 'e2', name: 'base', value: 'x' }, host)).toBe('Prod · base')
    expect(summarizeToolCall('set_environment_variable', { name: 'base', value: 'x' }, host)).toBe('Dev · base')
  })

  it('searches saved requests by name, URL or method', async () => {
    const results = parse((await runAgentTool('search_collections', { query: 'users' }, fakeHost([]), 'New request')).content).results
    expect(results).toEqual([
      { kind: 'collection', id: 'c1', name: 'Users API', path: 'Users API' },
      { kind: 'request', id: 'r1', name: 'List users', path: 'Users API', method: 'GET', url: '{{base}}/users' },
    ])
  })

  it('fails unknown tools and missing tabs without throwing', async () => {
    expect((await runAgentTool('rm_rf', {}, fakeHost([]), 'x')).isError).toBe(true)
    expect((await runAgentTool('get_response', { tabId: 'nope' }, fakeHost([]), 'x')).isError).toBe(true)
  })
})

describe('runAgentTool — tabs, scripts and highlights', () => {
  it('writes scripts and returns them when reading the request', async () => {
    const host = fakeHost([tab('t1', restContent())])
    const script = "al.test('status', () => al.expect(al.response.status).toBe(200))"
    expect((await runAgentTool('update_request', { postResponseScript: script }, host, 'x')).isError).toBe(false)
    expect(host.tabs()[0].content.postResponseScript).toBe(script)
    expect(parse((await runAgentTool('get_request', {}, host, 'x')).content).postResponseScript).toBe(script)
  })

  it('closes a tab and asks first only when it has unsaved changes', async () => {
    const clean = { ...tab('clean', restContent()), dirty: false }
    const host = fakeHost([tab('dirty', restContent()), clean])
    expect(toolNeedsApproval('close_tab', { tabId: 'dirty' }, host)).toBe(true)
    expect(toolNeedsApproval('close_tab', { tabId: 'clean' }, host)).toBe(false)
    expect(toolNeedsApproval('select_tab', { tabId: 'dirty' }, host)).toBe(false)
    expect(parse((await runAgentTool('close_tab', { tabId: 'clean' }, host, 'x')).content)).toEqual({ closedTabId: 'clean' })
    expect(host.closeTab).toHaveBeenCalledWith('clean')
  })

  it('highlights in the requested editor and explains misses', async () => {
    const host = fakeHost([tab('t1', restContent())])
    const outcome = await runAgentTool('highlight_in_editor', { target: 'request', field: 'body', text: 'id' }, host, 'x')
    expect(parse(outcome.content)).toEqual({ tabId: 't1', editor: 'body', matches: 2 })
    expect(host.highlight).toHaveBeenCalledWith('t1', 'request', 'body', 'id')

    vi.mocked(host.highlight).mockResolvedValueOnce({ ok: false, reason: 'noResponse' })
    const miss = await runAgentTool('highlight_in_editor', { target: 'response', text: 'id' }, host, 'x')
    expect(miss.isError).toBe(true)
    expect(miss.content).toContain('send the request')

    expect((await runAgentTool('highlight_in_editor', { target: 'response', field: 'body', text: 'id' }, host, 'x')).isError).toBe(true)
    expect((await runAgentTool('highlight_in_editor', { target: 'request', field: 'headers', text: 'id' }, host, 'x')).isError).toBe(true)
  })
})
