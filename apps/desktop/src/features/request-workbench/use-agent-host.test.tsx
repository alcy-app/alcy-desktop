import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedCollectionDataDto } from '../../bindings/import-collections'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import { ToastProvider } from '../../shared/ui/Toast'
import { useEnvironmentsState } from '../environments/use-environments-state'
import { runAgentTool, type AgentToolOutcome } from '../agent/agent-tools'
import { findRequest } from './collection-tree'
import { useAgentHost } from './use-agent-host'
import { requestToDto, useCollectionsState } from './use-collections-state'
import { emptyRequestContent } from './collection-tree'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

function wrapper({ children }: { children: ReactNode }) {
  return <LanguageProvider><ToastProvider>{children}</ToastProvider></LanguageProvider>
}

function imported(): ImportedCollectionDataDto {
  const request = requestToDto({ id: 'source-request', name: 'Users', protocol: 'rest', content: {
    ...emptyRequestContent('rest'), endpointUrl: 'https://example.test/users',
    authentication: { type: 'bearer', token: 'imported-credential' },
    preRequestScript: 'al.variables.set("prepared", true)',
  }, docsRef: { sourceId: 'docs-source', operationId: 'getUsers' } })
  return {
    collections: [{ id: 'source-collection', name: 'API', authentication: { type: 'none' }, requests: [], folders: [
      { id: 'source-folder', name: 'Users', authentication: { type: 'inherit' }, requests: [request], folders: [] },
    ] }],
    environments: [{ id: 'source-env', name: 'Imported', variables: [{ name: 'token', value: 'environment-credential', sensitive: true }] }],
    scriptCount: 1,
    warnings: [{ requestPath: 'API/Users', phase: 'preRequest', line: 1, api: 'pm.sendRequest', reason: 'unsupported' }],
  }
}

function setup() {
  const openRequest = vi.fn()
  const openDraft = vi.fn()
  const sendActive = vi.fn()
  const hook = renderHook(() => {
    const environments = useEnvironmentsState('/workspace')
    const collections = useCollectionsState('/workspace', environments.importEnvironments)
    const host = useAgentHost({
      workspaceRootPath: '/workspace', collections, environments, sendActive,
      workbench: { tabs: [], activeTabId: 'kept-tab', openRequest, openDraft } as unknown as Parameters<typeof useAgentHost>[0]['workbench'],
      openTabs: { activeOpenTab: { id: 'kept-tab' } } as Parameters<typeof useAgentHost>[0]['openTabs'],
    })
    return { host, loaded: collections.loaded && environments.loaded }
  }, { wrapper })
  return { ...hook, openRequest, openDraft, sendActive }
}

beforeEach(() => {
  invoke.mockReset().mockImplementation(async (command: string) => {
    switch (command) {
      case 'list_collections': return []
      case 'list_environments': return { environments: [], activeEnvironmentId: null }
      case 'import_collections_from_text': return imported()
      case 'save_collections':
      case 'save_environments': return undefined
      default: throw new Error(`Unexpected command ${command}`)
    }
  })
})

describe('agent text import', () => {
  it('persists hierarchy, documentation, scripts and environments with fresh ids, without opening or sending requests', async () => {
    const { result, openRequest, openDraft, sendActive } = setup()
    await waitFor(() => expect(result.current.loaded).toBe(true))
    let outcome: AgentToolOutcome | undefined
    await act(async () => { outcome = await runAgentTool('import_from_text', { content: 'original document' }, result.current.host, 'New request') })
    expect(outcome?.isError).toBe(false)
    const summary = JSON.parse(outcome!.content)
    expect(summary).toMatchObject({ collectionCount: 1, folderCount: 1, requestCount: 1, environmentCount: 1, scriptCount: 1, warningCount: 1, tabId: null })
    expect(invoke).toHaveBeenCalledWith('import_collections_from_text', { input: { content: 'original document', rootPath: '/workspace' } })
    expect(invoke.mock.calls.filter(([command]) => command === 'save_collections')).toHaveLength(1)
    expect(invoke.mock.calls.filter(([command]) => command === 'save_environments')).toHaveLength(1)
    expect(summary.collections[0].id).not.toBe('source-collection')
    expect(summary.environments[0].id).not.toBe('source-env')
    expect(summary.firstRequestId).not.toBe('source-request')
    expect(findRequest(result.current.host.collections(), summary.firstRequestId)).toMatchObject({
      docsRef: { sourceId: 'docs-source', operationId: 'getUsers' },
      content: { preRequestScript: 'al.variables.set("prepared", true)', authentication: { type: 'bearer', token: 'imported-credential' } },
    })
    expect(result.current.host.environments()[0].variables[0]).toMatchObject({ value: 'environment-credential', sensitive: true })
    expect(outcome?.content).not.toMatch(/imported-credential|environment-credential|preRequestScript/)
    expect(openRequest).not.toHaveBeenCalled()
    expect(openDraft).not.toHaveBeenCalled()
    expect(sendActive).not.toHaveBeenCalled()
    expect(result.current.host.activeTabId()).toBe('kept-tab')
  })

  it('does not modify workspace state when parsing fails', async () => {
    const { result } = setup()
    await waitFor(() => expect(result.current.loaded).toBe(true))
    invoke.mockRejectedValueOnce({ kind: 'invalid', message: 'Unsupported import content' })
    let outcome: AgentToolOutcome | undefined
    await act(async () => { outcome = await runAgentTool('import_from_text', { content: 'invalid' }, result.current.host, 'New request') })
    expect(outcome).toMatchObject({ isError: true })
    expect(outcome?.content).toContain('Unsupported import content')
    expect(result.current.host.collections()).toEqual([])
    expect(result.current.host.environments()).toEqual([])
    expect(invoke.mock.calls.some(([command]) => command.startsWith('save_'))).toBe(false)
  })

  it('reports partial persistence if saving environments fails after saving collections', async () => {
    const { result } = setup()
    await waitFor(() => expect(result.current.loaded).toBe(true))
    const implementation = invoke.getMockImplementation()!
    invoke.mockImplementation(async (command: string) => {
      if (command === 'save_environments') throw { kind: 'storage', message: 'Environment storage unavailable' }
      return implementation(command)
    })
    let outcome: AgentToolOutcome | undefined
    await act(async () => { outcome = await runAgentTool('import_from_text', { content: 'original document' }, result.current.host, 'New request') })
    expect(outcome?.isError).toBe(true)
    expect(outcome?.content).toContain('Collections were imported, but environments could not be saved')
    expect(result.current.host.collections()).toHaveLength(1)
    expect(result.current.host.environments()).toEqual([])
  })

  it('does not report success or save environments when collection persistence fails', async () => {
    const { result } = setup()
    await waitFor(() => expect(result.current.loaded).toBe(true))
    const implementation = invoke.getMockImplementation()!
    invoke.mockImplementation(async (command: string) => {
      if (command === 'save_collections') throw { kind: 'storage', message: 'Collection storage unavailable' }
      return implementation(command)
    })
    let outcome: AgentToolOutcome | undefined
    await act(async () => { outcome = await runAgentTool('import_from_text', { content: 'original document' }, result.current.host, 'New request') })
    expect(outcome?.isError).toBe(true)
    expect(outcome?.content).toContain('Collection storage unavailable')
    expect(result.current.host.collections()).toEqual([])
    expect(invoke.mock.calls.some(([command]) => command === 'save_environments')).toBe(false)
  })

  it('keeps successive imports distinct and uses unique collection names', async () => {
    const { result } = setup()
    await waitFor(() => expect(result.current.loaded).toBe(true))
    await act(async () => { await result.current.host.importFromText('first document') })
    await act(async () => { await result.current.host.importFromText('second document') })
    const collections = result.current.host.collections()
    expect(collections).toHaveLength(2)
    expect(new Set(collections.map(({ name }) => name)).size).toBe(2)
    expect(new Set(collections.map(({ id }) => id)).size).toBe(2)
    expect(new Set(collections.map(({ folders }) => folders[0].requests[0].id)).size).toBe(2)
    expect(new Set(result.current.host.environments().map(({ id }) => id)).size).toBe(2)
  })
})
