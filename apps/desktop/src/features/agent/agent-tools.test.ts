import { describe, expect, it, vi } from 'vitest'
import { emptyRequestContent, type RequestContent, type TreeNode } from '../request-workbench/collection-tree'
import type { ExecutionState } from '../request-workbench/request-workbench.types'
import type { AgentHostTab, WorkbenchAgentHost } from './agent-host'
import { AGENT_SECRET_MASK, runAgentTool, toolNeedsApproval } from './agent-tools'

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
    createCollection: vi.fn(() => 'c2'),
    createFolder: vi.fn(() => 'f1'),
    setVariable: vi.fn(),
    setActiveEnvironment: vi.fn(),
    ...overrides,
  }
}

const parse = (content: string) => JSON.parse(content) as Record<string, unknown>

describe('runAgentTool', () => {
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
