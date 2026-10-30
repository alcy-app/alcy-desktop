import { describe, expect, it, vi } from 'vitest'
import type { WorkbenchAgentHost } from './agent-host'
import { emptyRequestContent, type TreeNode } from '../request-workbench/collection-tree'
import { agentReferenceResolver, openAgentReference } from './agent-references'

describe('openAgentReference', () => {
  it('opens each kind through the workbench and reports missing items', async () => {
    const call = vi.fn(async (name: string) => ({ content: '', isError: name === 'open_mock_server' }))
    const host = {
      openRequest: vi.fn(async (id: string) => (id === 'r1' ? 'tab-1' : null)),
      selectTab: vi.fn(async () => { throw new Error('closed') }),
      resources: { call },
    } as unknown as WorkbenchAgentHost
    expect(await openAgentReference(host, 'request', 'r1')).toBe(true)
    expect(await openAgentReference(host, 'request', 'gone')).toBe(false)
    expect(await openAgentReference(host, 'flow', 'f1')).toBe(true)
    expect(call).toHaveBeenCalledWith('open_flow', { flowId: 'f1' })
    expect(await openAgentReference(host, 'mock', 'm1')).toBe(false)
    expect(call).toHaveBeenCalledWith('open_mock_server', { serverId: 'm1' })
    expect(await openAgentReference(host, 'tab', 't1')).toBe(false)
  })
})

describe('agentReferenceResolver', () => {
  it('finds saved requests, flows and mocks by id or by a name only one item has', () => {
    const request = (id: string, name: string) => ({ id, name, protocol: 'rest', content: emptyRequestContent('rest') })
    const collections = [
      { id: 'c', name: 'Sample API', folders: [{ id: 'f', name: 'Users', folders: [], requests: [request('r1', 'Get Users')] }], requests: [request('r2', 'Health'), request('r3', 'Health')] },
    ] as unknown as TreeNode[]
    const host = {
      collections: () => collections,
      resources: { context: () => [
        { kind: 'flow', id: 'flow-1', label: 'Checkout', summary: '' },
        { kind: 'mock', id: 'mock-1', label: 'Payments', summary: '' },
        { kind: 'monitor', id: 'mon-1', label: 'Status', summary: '' },
      ] },
    } as unknown as WorkbenchAgentHost
    const resolve = agentReferenceResolver(host)
    expect(resolve('Get Users')).toEqual({ kind: 'request', id: 'r1' })
    expect(resolve(' get users ')).toEqual({ kind: 'request', id: 'r1' })
    expect(resolve('r2')).toEqual({ kind: 'request', id: 'r2' })
    expect(resolve('Checkout')).toEqual({ kind: 'flow', id: 'flow-1' })
    expect(resolve('Payments')).toEqual({ kind: 'mock', id: 'mock-1' })
    expect(resolve('Health')).toBeNull()
    expect(resolve('Status')).toBeNull()
    expect(resolve('Método:')).toBeNull()
  })
})
