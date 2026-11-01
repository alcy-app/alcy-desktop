import { describe, expect, it } from 'vitest'
import { mentionAt, mentionContext } from './agent-context'
import type { WorkbenchAgentHost } from './agent-host'
import type { TreeNode } from '../request-workbench/collection-tree'

describe('mentionAt', () => {
  it('finds the @query right before the caret', () => {
    expect(mentionAt('explain @us', 11)).toEqual({ start: 8, query: 'us' })
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' })
  })

  it('ignores e-mail addresses, finished mentions and text after the caret', () => {
    expect(mentionAt('ana@example.com', 15)).toBeNull()
    expect(mentionAt('@users and more', 15)).toBeNull()
    expect(mentionAt('hello @world', 3)).toBeNull()
  })
})

describe('mentionContext', () => {
  const node = (id: string, name: string, folders: TreeNode[] = [], requests: TreeNode['requests'] = []) => ({ id, name, folders, requests }) as TreeNode
  const request = { id: 'r1', name: 'List', protocol: 'rest', content: { method: 'get', endpointUrl: 'https://api/users' } } as unknown as TreeNode['requests'][number]
  const host = {
    collections: () => [node('c1', 'Store', [node('f1', 'Users', [], [request])])],
    tabs: () => [],
    activeTabId: () => null,
    environments: () => [],
    resources: { context: () => [{ kind: 'mock', id: 'm1', label: 'Payments', summary: 'Mock server. Read with get_mock_server.' }] },
  } as unknown as WorkbenchAgentHost

  it('describes collections, folders and requests from the tree', () => {
    expect(mentionContext(host, { kind: 'collection', id: 'c1', label: 'Store' }).summary).toBe('1 folders, 1 requests. Collection. Read with get_collection.')
    expect(mentionContext(host, { kind: 'folder', id: 'f1', label: 'Users' }).summary).toBe('In Store. 0 folders, 1 requests. Collection folder. Read with get_collection.')
    expect(mentionContext(host, { kind: 'request', id: 'r1', label: 'List' }).summary).toBe('Store / Users\nGET https://api/users')
  })

  it('reads other items from the workbench resources and falls back to how to read them', () => {
    expect(mentionContext(host, { kind: 'mock', id: 'm1', label: 'old' })).toMatchObject({ label: 'Payments', summary: 'Mock server. Read with get_mock_server.' })
    expect(mentionContext(host, { kind: 'flow', id: 'gone', label: 'Login' })).toEqual({ kind: 'flow', id: 'gone', label: 'Login', summary: 'Flow. Read with get_flow.' })
    expect(mentionContext(host, { kind: 'field', id: '$.id', label: 'id', summary: '1' }).summary).toBe('Value at $.id in the response:\n1')
  })
})
