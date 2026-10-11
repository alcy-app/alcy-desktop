import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runBeforeExit } from '../../shared/app-lifecycle/before-exit'
import { emptyRequestContent } from './collection-tree'
import type { RequestContent, TreeNode } from './collection-tree'
import { useTabSession } from './use-tab-session'
import { contentOf, useWorkbenchState } from './use-workbench-state'

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
    const session = useTabSession({
      rootPath: '/workspace',
      tabs: workbench.tabs,
      activeTabId: workbench.activeTabId,
      collections,
      collectionsLoaded: true,
      contentOf,
      restoreTabs: workbench.restoreTabs,
    })
    return { workbench, session }
  })
}

beforeEach(() => {
  loadTabSession.mockReset()
  saveTabSession.mockReset()
  saveTabSession.mockResolvedValue({ ok: true, value: null })
})

describe('useTabSession', () => {
  it('não regrava a sessão carregada quando o snapshot continua igual', async () => {
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

  it('grava imediatamente a edição pendente e limpa dirty depois de salvar', async () => {
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
