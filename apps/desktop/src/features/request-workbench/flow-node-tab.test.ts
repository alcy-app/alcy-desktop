import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { emptyRequestContent } from './collection-tree'
import { isTabDirty, useWorkbenchState } from './use-workbench-state'

const noVariables: never[] = []
const noCollections: never[] = []

describe('aba de requisição avulsa de flow', () => {
  it('abre sem alterações pendentes, reaproveita a aba do mesmo node e marca edições como não salvas', () => {
    const { result } = renderHook(() => useWorkbenchState(noVariables, '/workspace', noCollections))
    const content = { ...emptyRequestContent('rest'), endpointUrl: 'https://api.test/a' }
    const ref = { flowId: 'flow-1', nodeId: 'node-1' }

    act(() => result.current.openFlowNodeRequest(ref, 'Avulsa', content))
    act(() => result.current.openFlowNodeRequest(ref, 'Avulsa', content))

    expect(result.current.tabs).toHaveLength(1)
    const tab = result.current.activeTab
    expect(tab.flowNodeRef).toEqual(ref)
    expect(tab.requestId).toBeNull()
    expect(isTabDirty(tab)).toBe(false)

    act(() => result.current.setEndpointUrl('https://api.test/b'))
    expect(isTabDirty(result.current.activeTab)).toBe(true)

    act(() => result.current.markContentSaved(tab.id))
    expect(isTabDirty(result.current.activeTab)).toBe(false)
  })

  it('volta a ser um rascunho comum quando o node deixa de existir', () => {
    const { result } = renderHook(() => useWorkbenchState(noVariables, '/workspace', noCollections))
    act(() => result.current.openFlowNodeRequest({ flowId: 'f', nodeId: 'n' }, 'Avulsa', emptyRequestContent('rest')))

    act(() => result.current.detachRequest(result.current.activeTab.id))

    expect(result.current.activeTab.flowNodeRef).toBeUndefined()
    expect(isTabDirty(result.current.activeTab)).toBe(true)
  })
})
