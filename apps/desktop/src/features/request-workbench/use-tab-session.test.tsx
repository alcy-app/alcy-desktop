import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runBeforeExit } from '../../shared/app-lifecycle/before-exit'
import { emptyRequestContent } from './collection-tree'
import type { RequestContent, TreeNode } from './collection-tree'
import { useTabSession } from './use-tab-session'
import { contentOf, useWorkbenchState } from './use-workbench-state'
import { useTabGroups } from './use-tab-groups'
import type { OpenTabDescriptor } from './use-open-tabs'

const loadTabSession = vi.fn()
const saveTabSession = vi.fn()

vi.mock('../../bindings/load-tab-session', () => ({
  loadTabSession: (...args: unknown[]) => loadTabSession(...args),
}))

vi.mock('../../bindings/save-tab-session', () => ({
  saveTabSession: (...args: unknown[]) => saveTabSession(...args),
}))

const savedContent: RequestContent = {
  ...emptyRequestContent('rest'),
  endpointUrl: 'https://api.example.com/ping',
}

const collections: TreeNode[] = [
  {
    id: 'collection-1',
    name: 'API',
    folders: [],
    requests: [{ id: 'request-1', name: 'Ping', protocol: 'rest', content: savedContent }],
    authentication: { type: 'inherit' },
    variables: [],
  },
]

function renderSession() {
  return renderHook(() => {
    const workbench = useWorkbenchState([], '/workspace', collections)
    const descriptors: OpenTabDescriptor[] = workbench.tabs.map((tab) => ({ id: tab.id, label: tab.name, kind: 'request', fixed: tab.fixed === true, dirty: tab.dirty, preview: !tab.pinned }))
    const groups = useTabGroups(descriptors, workbench.pinTab)
    const session = useTabSession({
      rootPath: '/workspace',
      tabs: workbench.tabs,
      activeTabId: workbench.activeTabId,
      collections,
      collectionsLoaded: true,
      contentOf,
      restoreTabs: workbench.restoreTabs,
      groups: groups.groups,
      restoreGroups: groups.restoreGroups,
    })
    return { workbench, session, groups }
  })
}

beforeEach(() => {
  loadTabSession.mockReset()
  saveTabSession.mockReset()
  saveTabSession.mockResolvedValue({ ok: true, value: null })
})

describe('useTabSession', () => {
  it('restores collapsed groups and flushes organization changes without editing requests', async () => {
    const group = { id: 'billing', name: 'Billing', color: 'blue', collapsed: true, tabIds: ['tab-1'] }
    loadTabSession.mockResolvedValue({ ok: true, value: { version: 1, activeTabId: 'tab-1', tabs: [{ id: 'tab-1', requestId: 'request-1', name: 'Ping', draft: null }], groups: [group] } })
    const { result } = renderSession()
    await waitFor(() => expect(result.current.session.restored).toBe(true))
    expect(result.current.groups.groups).toEqual([group])
    await act(async () => runBeforeExit())
    expect(saveTabSession).not.toHaveBeenCalled()
    act(() => result.current.groups.updateGroup('billing', { name: 'Orders', color: 'green' }))
    await act(async () => runBeforeExit())
    expect(saveTabSession).toHaveBeenLastCalledWith('/workspace', expect.objectContaining({ groups: [{ ...group, name: 'Orders', color: 'green' }] }))
  })

  it('does not rewrite a loaded session when its snapshot is unchanged', async () => {
    loadTabSession.mockResolvedValue({
      ok: true,
      value: {
        version: 1,
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1', requestId: 'request-1', name: 'Ping', draft: null }],
      },
    })
    const { result } = renderSession()

    await waitFor(() => expect(result.current.session.restored).toBe(true))
    expect(result.current.workbench.activeTab.name).toBe('Ping')

    await act(async () => runBeforeExit())

    expect(saveTabSession).not.toHaveBeenCalled()
  })

  it('flushes pending edits and clears dirty state after saving', async () => {
    loadTabSession.mockResolvedValue({
      ok: true,
      value: {
        version: 1,
        activeTabId: 'tab-1',
        tabs: [
          {
            id: 'tab-1',
            requestId: 'request-1',
            name: 'Ping',
            draft: { ...savedContent, endpointUrl: 'https://api.example.com/edited' },
          },
        ],
      },
    })
    const { result } = renderSession()

    await waitFor(() => expect(result.current.session.restored).toBe(true))
    expect(result.current.workbench.activeTab.dirty).toBe(true)
    expect(result.current.workbench.activeTab.endpointUrl).toBe('https://api.example.com/edited')

    act(() => result.current.workbench.setEndpointUrl('https://api.example.com/edited-again'))

    await act(async () => runBeforeExit())

    expect(saveTabSession).toHaveBeenCalledWith(
      '/workspace',
      expect.objectContaining({
        activeTabId: 'tab-1',
        tabs: [
          expect.objectContaining({ id: 'tab-1', draft: expect.objectContaining({ endpointUrl: 'https://api.example.com/edited-again' }) }),
        ],
      }),
    )

    act(() => result.current.workbench.markContentSaved('tab-1'))
    expect(result.current.workbench.activeTab.dirty).toBe(false)

    await act(async () => runBeforeExit())
    expect(saveTabSession).toHaveBeenLastCalledWith(
      '/workspace',
      expect.objectContaining({ tabs: [expect.objectContaining({ id: 'tab-1', draft: null })] }),
    )
  })
})
