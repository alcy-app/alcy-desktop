import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentResourceBridge, type RunnerAgentController } from './agent-resource-bridge'
import { useAgentResources } from './use-agent-resources'
import { createFlow, dtoFromFlow } from '../flows/use-flows-state'
import { emptyRequestContent, type TreeNode } from '../request-workbench/collection-tree'
import { DEFAULT_RUNNER_SETTINGS } from '../collection-runner/runner-settings'
import { idleRunState } from '../collection-runner/collection-run-state'
import type { MockServerDto } from '../../bindings/mock-servers'
import { cancelFlowOutputQuery, inspectFlowOutput } from '../../bindings/inspect-flow-output'

const flags = vi.hoisted(() => ({ loadTesting: false, valueMonitors: true }))
vi.mock('../../shared/feature-flags', () => ({ FEATURE_FLAGS: flags }))
const saveMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })))
const startMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })))
const previewLoad = vi.hoisted(() => vi.fn(async () => ({ ok: true, value: { destinations: ['https://example.test'], peakVus: 2 } })))
vi.mock('../../bindings/mock-servers', () => ({
  saveMockServer: saveMock, startMockServer: startMock, stopMockServer: vi.fn(), validateMockServer: vi.fn(async () => ({ ok: true })),
  getMockServer: vi.fn(), listMockServers: vi.fn(), deleteMockServer: vi.fn(),
  clearMockCalls: vi.fn(), listMockCalls: vi.fn(),
}))
vi.mock('../../bindings/preview-load-flow', () => ({ previewLoadFlow: previewLoad }))
vi.mock('../../bindings/cancel-load-flow', () => ({ cancelLoadFlow: vi.fn() }))
vi.mock('../../bindings/cancel-flow', () => ({ cancelFlow: vi.fn() }))
vi.mock('../../bindings/inspect-flow-output', () => ({ inspectFlowOutput: vi.fn(), cancelFlowOutputQuery: vi.fn().mockResolvedValue(undefined) }))
const checkFlowMock = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []))
vi.mock('../../bindings/check-flow', () => ({ checkFlow: checkFlowMock }))

type Sources = Parameters<typeof useAgentResources>[0]

function setup() {
  const original = createFlow('Original')
  original.id = 'flow'
  const tree: TreeNode[] = [{ id: 'collection', name: 'Users', authentication: { type: 'none' }, variables: [], folders: [], requests: [{ id: 'request', name: 'Get users', protocol: 'rest', content: emptyRequestContent('rest') }] }]
  const state = {
    rootPath: '/agent-tests', bridge: new AgentResourceBridge('/agent-tests'),
    flows: { flows: [original], folders: [], commitSnapshot: vi.fn(async (change: (current: Sources['flows']) => Sources['flows']) => { Object.assign(state.flows, change(state.flows as unknown as Sources['flows'])) }) },
    monitors: { monitors: [{ id: 'monitor', name: 'Names', enabled: true, fields: ['name'], rules: [{ id: 'rule', kind: 'notEmpty' }] }], commitMonitors: vi.fn(async (change: (current: typeof state.monitors.monitors) => typeof state.monitors.monitors) => { state.monitors.monitors = change(state.monitors.monitors) }) },
    collections: { collections: tree, commitCollections: vi.fn(async (change: (current: TreeNode[]) => TreeNode[]) => { state.collections.collections = change(state.collections.collections) }) },
    environments: { environments: [{ id: 'environment', name: 'Dev', variables: [{ id: 'secret', name: 'token', value: 'fake-credential', sensitive: true }] }], commitEnvironments: vi.fn(async (change: (current: { environments: typeof state.environments.environments; activeEnvironmentId: string | null }) => { environments: typeof state.environments.environments; activeEnvironmentId: string | null }) => { Object.assign(state.environments, change({ environments: state.environments.environments, activeEnvironmentId: 'environment' })) }) },
    openTabs: { runnerTabs: [], mockServerTabs: [], openFlow: vi.fn(), openRunner: vi.fn(), openMockServer: vi.fn(), closeOpenTab: vi.fn() },
    workbench: { tabs: [] }, onSaved: vi.fn(),
  }
  const hook = renderHook(() => useAgentResources(state as unknown as Sources))
  const call = async (name: string, input: Record<string, unknown> = {}) => {
    let result!: Awaited<ReturnType<typeof hook.result.current.call>>
    await act(async () => { result = await hook.result.current.call(name, input) })
    return { ...result, value: JSON.parse(result.content) as Record<string, unknown> }
  }
  return { state, call, ...hook }
}

beforeEach(() => { flags.loadTesting = false; flags.valueMonitors = true; vi.clearAllMocks() })

describe('workspace resource tools', () => {
  it('cancels pending native output inspections without cancelling flow execution', async () => {
    const h = setup()
    let rejectRead: (error: Error) => void = () => {}
    vi.mocked(inspectFlowOutput).mockImplementationOnce(() => new Promise((_, reject) => { rejectRead = reject }))
    const cancel = vi.fn()
    h.state.bridge.register('flow', 'flow', { read: () => dtoFromFlow(h.state.flows.flows[0]), replace: vi.fn(), renameNode: vi.fn(), status: () => ({ flowExecutionId: 'execution', isRunning: true }), run: vi.fn(), cancel })
    let pending!: ReturnType<typeof h.result.current.call>
    act(() => { pending = h.result.current.call('get_flow_output', { flowId: 'flow', nodeId: 'request' }) })
    h.result.current.cancelReads?.()
    expect(cancelFlowOutputQuery).toHaveBeenCalledWith(expect.any(String))
    expect(cancel).not.toHaveBeenCalled()
    await act(async () => { rejectRead(new Error('Cancelled')); expect((await pending).isError).toBe(true) })
  })

  it('creates a flow then reads and edits the same persisted resource in sequential calls', async () => {
    const h = setup()
    const created = await h.call('create_flow', { name: 'New flow', upsertNodes: [{ id: 'message', kind: 'log', message: 'Hello' }] })
    expect(created.isError).toBe(false)
    const id = created.value.flowId
    expect(h.state.openTabs.openFlow).toHaveBeenCalledWith(id)
    const read = await h.call('get_flow', { flowId: id, nodeId: 'message' })
    expect(read.value.message).toBe('Hello')
    await h.call('update_flow', { flowId: id, upsertNodes: [{ id: 'message', message: 'Changed' }] })
    expect((await h.call('get_flow', { flowId: id, nodeId: 'message' })).value.message).toBe('Changed')
  })

  it('does not claim a successful flow save when native validation fails', async () => {
    const h = setup()
    h.state.flows.commitSnapshot.mockRejectedValueOnce(new Error('Invalid graph'))
    const result = await h.call('create_flow', { name: 'Invalid' })
    expect(result.isError).toBe(true)
    expect(h.state.flows.flows).toHaveLength(1)
    expect(h.state.openTabs.openFlow).not.toHaveBeenCalled()
  })

  it('returns the mounted graph rather than an older workspace snapshot', async () => {
    const h = setup()
    const current = { ...dtoFromFlow(h.state.flows.flows[0]), name: 'Current editor' }
    h.state.bridge.register('flow', 'flow', { read: () => current, replace: vi.fn(), renameNode: vi.fn(), status: () => ({ isRunning: false }), run: vi.fn(), cancel: vi.fn() })
    expect((await h.call('get_flow', { flowId: 'flow' })).value.name).toBe('Current editor')
  })

  it('blocks disabled features and invalid target ids without mutation', async () => {
    const h = setup()
    expect((await h.call('create_flow', { name: 'Load', executionKind: 'load' })).isError).toBe(true)
    flags.valueMonitors = false
    expect((await h.call('create_value_monitor', { name: 'Check' })).isError).toBe(true)
    expect((await h.call('delete_flow', { flowId: 'missing' })).isError).toBe(true)
    expect(h.state.flows.commitSnapshot).not.toHaveBeenCalled()
    expect(h.state.monitors.commitMonitors).not.toHaveBeenCalled()
  })

  it('updates and deletes monitors and leaves existing rules on a rename', async () => {
    const h = setup()
    await h.call('update_value_monitor', { monitorId: 'monitor', name: 'Required names' })
    expect(h.state.monitors.monitors[0]).toMatchObject({ name: 'Required names', rules: [{ id: 'rule' }] })
    await h.call('delete_value_monitor', { monitorId: 'monitor' })
    expect(h.state.monitors.monitors).toEqual([])
  })

  it('does not leak sensitive values in a native error', async () => {
    const h = setup()
    h.state.monitors.commitMonitors.mockRejectedValueOnce(new Error('Rejected fake-credential'))
    const result = await h.call('create_value_monitor', { name: 'Check' })
    expect(result.isError).toBe(true)
    expect(result.content).not.toContain('fake-credential')
  })

  it('configures runners reversibly and refuses to undo a later manual change', async () => {
    const h = setup()
    let current = { requestIds: ['request'], settings: DEFAULT_RUNNER_SETTINGS, dataFile: { status: 'none' as const }, state: idleRunState, error: null }
    const controller: RunnerAgentController = {
      read: () => current,
      configure: (next) => { current = { ...current, ...next } }, pickDataFile: vi.fn(), clearDataFile: vi.fn(), run: vi.fn(async () => 'run'), cancel: vi.fn(),
    }
    h.state.bridge.register('runner', 'runner', controller)
    const result = await h.call('configure_runner', { runnerId: 'runner', options: { iterations: 3, stopOnError: true } })
    expect(current.settings).toMatchObject({ iterations: '3', stopOnError: true })
    expect(result.revert?.()).toBe(true)
    expect(current.settings).toEqual(DEFAULT_RUNNER_SETTINGS)
    const second = await h.call('configure_runner', { runnerId: 'runner', options: { iterations: 2 } })
    current = { ...current, settings: { ...current.settings, iterations: '4' } }
    expect(second.revert?.()).toBe(false)
    expect(current.settings.iterations).toBe('4')
  })

  it('starts and cancels through the runner controller without waiting for a whole run', async () => {
    const h = setup()
    const run = vi.fn(async () => 'run-1')
    const cancel = vi.fn()
    h.state.bridge.register('runner', 'runner', { read: () => ({ requestIds: ['request'], settings: DEFAULT_RUNNER_SETTINGS, dataFile: { status: 'none' }, state: idleRunState, error: null }), configure: vi.fn(), pickDataFile: vi.fn(), clearDataFile: vi.fn(), run, cancel })
    expect((await h.call('run_runner', { runnerId: 'runner' })).value.runId).toBe('run-1')
    await h.call('cancel_runner', { runnerId: 'runner' })
    expect(run).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('edits the current mock draft and requires saving it before starting', async () => {
    const h = setup()
    let current: { server: MockServerDto; dirty: boolean; busy: boolean } = { server: { id: 'mock', name: 'Mock', port: 3001, corsEnabled: true, routes: [] }, dirty: false, busy: false }
    const save = vi.fn(async () => { current = { ...current, dirty: false } })
    h.state.bridge.register('mock', 'mock', { read: () => current, replace: (server) => { current = { ...current, server, dirty: true } }, save })
    const edited = await h.call('update_mock_server', { serverId: 'mock', patch: { port: 4000 } })
    expect(edited.isError).toBe(false)
    expect(current.server.port).toBe(4000)
    expect((await h.call('start_mock_server', { serverId: 'mock' })).isError).toBe(true)
    expect(startMock).not.toHaveBeenCalled()
    await h.call('save_mock_server', { serverId: 'mock' })
    expect(save).toHaveBeenCalledOnce()
    expect((await h.call('start_mock_server', { serverId: 'mock' })).isError).toBe(false)
  })

  it('duplicates trees with new ids and rejects invalid moves', async () => {
    const h = setup()
    const duplicate = await h.call('duplicate_collection_item', { itemId: 'collection' })
    expect(duplicate.isError).toBe(false)
    expect(h.state.collections.collections).toHaveLength(2)
    expect(h.state.collections.collections[1].requests[0].id).not.toBe('request')
    expect((await h.call('update_collection_item', { itemId: 'collection', parentId: 'collection' })).isError).toBe(true)
  })

  it('creates a saved request in a collection without opening a tab', async () => {
    const h = setup()
    const created = await h.call('create_request', { parentId: 'collection', name: 'Create user', protocol: 'rest', method: 'post', url: '{{base}}/users', body: { type: 'raw', content: '{"name":"Ana"}' } })
    expect(created.isError).toBe(false)
    const request = h.state.collections.collections[0].requests.find((item) => item.id === created.value.requestId)
    expect(request).toEqual(expect.objectContaining({ name: 'Create user', protocol: 'rest' }))
    expect(request?.content).toEqual(expect.objectContaining({ method: 'post', endpointUrl: '{{base}}/users', body: { type: 'raw', content: '{"name":"Ana"}', rawLanguage: 'json' } }))
    expect(h.state.openTabs.openFlow).not.toHaveBeenCalled()
    expect(h.state.workbench.tabs).toHaveLength(0)

    expect((await h.call('create_request', { parentId: 'missing', name: 'x', protocol: 'rest' })).isError).toBe(true)
    expect((await h.call('create_request', { parentId: 'collection', name: 'x', protocol: 'grpc' })).isError).toBe(true)
  })

  it('duplicates a request with edits into another folder, leaving the original as it was', async () => {
    const h = setup()
    h.state.collections.collections = [
      {
        ...h.state.collections.collections[0],
        requests: [{ id: 'request', name: 'Get users', protocol: 'rest', content: { ...emptyRequestContent('rest'), endpointUrl: '{{base}}/users', authentication: { type: 'bearer', token: 'raw-token' } } }],
        folders: [{ id: 'admin', name: 'Admin', authentication: { type: 'inherit' }, variables: [], folders: [], requests: [] }],
      },
    ]
    const copy = await h.call('duplicate_collection_item', { itemId: 'request', name: 'Get one user', url: '{{base}}/users/1', authentication: { type: 'bearer', token: '••••' }, parentId: 'admin' })
    expect(copy.isError).toBe(false)
    expect(copy.value.changed).toEqual(['url', 'authentication'])

    const [collection] = h.state.collections.collections
    const moved = collection.folders[0].requests[0]
    expect(moved).toEqual(expect.objectContaining({ id: copy.value.itemId, name: 'Get one user' }))
    expect(moved.content.endpointUrl).toBe('{{base}}/users/1')
    expect(moved.content.authentication).toEqual({ type: 'bearer', token: 'raw-token' })
    expect(collection.requests).toHaveLength(1)
    expect(collection.requests[0].content.endpointUrl).toBe('{{base}}/users')
  })

  it('refuses request edits when duplicating a folder or collection', async () => {
    const h = setup()
    expect((await h.call('duplicate_collection_item', { itemId: 'collection', url: 'https://x' })).isError).toBe(true)
    expect(h.state.collections.collections).toHaveLength(1)
  })

  it('offers resource references without including secret values', () => {
    const h = setup()
    expect(h.result.current.context()).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'flow', id: 'flow' }), expect.objectContaining({ kind: 'monitor', id: 'monitor' })]))
    expect(JSON.stringify(h.result.current.context())).not.toContain('fake-credential')
  })
})

describe('building flows step by step', () => {
  async function loginFlow(h: ReturnType<typeof setup>) {
    const flowId = (await h.call('create_flow', { name: 'Login' })).value.flowId as string
    await h.call('add_flow_node', { flowId, kind: 'inlineRequest', name: 'Login', method: 'post', url: '{{base}}/login', after: 'start' })
    await h.call('add_flow_node', { flowId, kind: 'inlineRequest', name: 'Profile', url: '{{base}}/me', authentication: { type: 'bearer', token: '{{nodes.login.response.body.token}}' }, after: 'login' })
    return flowId
  }

  it('adds connected steps with readable ids, outputs and free positions', async () => {
    const h = setup()
    const flowId = await loginFlow(h)
    const display = await h.call('add_flow_node', { flowId, kind: 'display', template: '{{nodes.profile.response.body}}', after: 'profile' })
    expect(display.value).toMatchObject({ nodeId: 'display', connected: [{ from: 'profile', to: 'display', output: 'success' }] })
    const outline = (await h.call('get_flow', { flowId })).value.nodes as { items: { id: string; next?: Record<string, string[]> }[] }
    expect(outline.items.map((node) => [node.id, node.next])).toEqual([['start', { next: ['login'] }], ['login', { success: ['profile'] }], ['profile', { success: ['display'] }], ['display', undefined]])
    const full = (await h.call('get_flow', { flowId, view: 'full' })).value.nodes as { items: { x: number; request?: Record<string, unknown> }[] }
    expect(full.items.map((node) => node.x)).toEqual([...full.items.map((node) => node.x)].sort((a, b) => a - b))
    expect(new Set(full.items.map((node) => node.x)).size).toBe(4)
    expect(full.items[1].request).toMatchObject({ name: 'Login', method: 'post', url: '{{base}}/login' })
  })

  it('inserts between two steps and keeps connections idempotent', async () => {
    const h = setup()
    const flowId = await loginFlow(h)
    await h.call('add_flow_node', { flowId, kind: 'log', name: 'Trace', message: 'logged in', after: 'login', before: 'profile' })
    const again = await h.call('connect_flow_nodes', { flowId, from: 'trace', to: 'profile' })
    expect(again.value).toMatchObject({ alreadyConnected: true })
    const outline = (await h.call('get_flow', { flowId })).value.nodes as { items: { id: string; next?: Record<string, string[]> }[] }
    expect(outline.items.find((node) => node.id === 'login')?.next).toEqual({ success: ['trace'] })
    expect(outline.items.find((node) => node.id === 'trace')?.next).toEqual({ next: ['profile'] })
  })

  it('inserts into a branch using its output and places batch nodes apart', async () => {
    const h = setup()
    const flowId = await loginFlow(h)
    await h.call('update_flow', { flowId, upsertNodes: [{ id: 'retry', kind: 'log', message: 'retry' }, { id: 'wait', kind: 'sleep' }], upsertEdges: [{ sourceNodeId: 'login', targetNodeId: 'retry', sourceHandle: 'failure' }, { sourceNodeId: 'retry', targetNodeId: 'wait' }] })
    const inserted = await h.call('add_flow_node', { flowId, kind: 'log', name: 'Note failure', after: 'login', before: 'retry' })
    expect(inserted.value.connected).toEqual([{ from: 'login', to: 'note_failure', output: 'failure' }, { from: 'note_failure', to: 'retry', output: null }])
    const nodes = ((await h.call('get_flow', { flowId, view: 'full' })).value.nodes as { items: { id: string; x: number; y: number }[] }).items
    const positions = nodes.map((node) => `${node.x},${node.y}`)
    expect(new Set(positions).size).toBe(nodes.length)
  })

  it('explains invalid outputs, unknown nodes and old request fields', async () => {
    const h = setup()
    const flowId = await loginFlow(h)
    const output = await h.call('connect_flow_nodes', { flowId, from: 'login', to: 'profile', output: 'true' })
    expect(output.isError).toBe(true)
    expect(output.content).toContain("outputs are 'success', 'failure'")
    const unknown = await h.call('add_flow_node', { flowId, kind: 'log', after: 'logon' })
    expect(unknown.content).toContain("No node 'logon'")
    expect(unknown.content).toContain('login')
    const legacy = await h.call('update_flow', { flowId, upsertNodes: [{ id: 'login', request: { endpoint: 'x' } }] })
    expect(legacy.content).toContain('write requests as in update_request')
  })

  it('creates flows from templates and from saved requests', async () => {
    const h = setup()
    const template = await h.call('create_flow', { name: 'Auth', template: 'authentication' })
    expect((template.value.nodes as { id: string }[]).map((node) => node.id)).toEqual(expect.arrayContaining(['start', 'login', 'profile', 'result']))
    const chained = await h.call('create_flow', { name: 'Users', requestIds: ['request'] })
    expect(chained.value.nodes).toEqual([{ id: 'start', kind: 'start', next: { next: ['get_users'] } }, { id: 'get_users', kind: 'request', summary: 'saved request Get users' }])
    expect((await h.call('create_flow', { name: 'Bad', requestIds: ['ghost'] })).content).toContain('search_collections')
  })

  it('undoes a graph edit only while the flow is unchanged', async () => {
    const h = setup()
    const flowId = await loginFlow(h)
    const first = await h.call('add_flow_node', { flowId, kind: 'log', after: 'profile' })
    const second = await h.call('add_flow_node', { flowId, kind: 'sleep', after: 'log' })
    expect(first.revert?.()).toBe(false)
    await act(async () => { expect(second.revert?.()).toBe(true) })
    const ids = (await h.call('get_flow', { flowId })).value.nodes as { items: { id: string }[] }
    expect(ids.items.map((node) => node.id)).toEqual(['start', 'login', 'profile', 'log'])
  })

  it('lists references and refuses to run a flow with errors', async () => {
    const h = setup()
    const flowId = await loginFlow(h)
    const references = await h.call('get_flow_references', { flowId, nodeId: 'profile' })
    expect(references.value.fromEarlierNodes).toEqual([{ nodeId: 'login', kind: 'inlineRequest', references: expect.arrayContaining(['{{nodes.login.response.body.<path>}}']) }])
    await h.call('add_flow_node', { flowId, kind: 'request', requestId: 'ghost', after: 'profile' })
    checkFlowMock.mockResolvedValueOnce([{ severity: 'warning', nodeId: 'profile', message: 'Unknown variable.', fix: 'Create it.' }])
    const check = await h.call('check_flow', { flowId })
    expect(check.value).toMatchObject({ ok: false, errors: 1, warnings: 1 })
    const run = await h.call('run_flow', { flowId })
    expect(run.isError).toBe(true)
    expect(run.content).toContain("saved request 'ghost'")
  })
})
