import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import type { FlowState } from '../flows/flows.types'
import type { AppNotification } from '../notifications/notifications.types'
import { emptyRequestContent } from './collection-tree'
import { useOpenTabs } from './use-open-tabs'
import { useWorkbenchState } from './use-workbench-state'

const noVariables: never[] = []
const noCollections: never[] = []
const flows = {
  flows: [{ id: 'flow-1', name: 'Flow', executionKind: 'standard', nodes: [], edges: [], createdAtMs: 0, updatedAtMs: 0 } satisfies FlowState],
}

function wrapper({ children }: { children: ReactNode }) {
  return <LanguageProvider>{children}</LanguageProvider>
}

function renderTabs() {
  return renderHook(
    () => {
      const workbench = useWorkbenchState(noVariables, '/workspace', noCollections)
      const openTabs = useOpenTabs(workbench, flows)
      return { workbench, openTabs }
    },
    { wrapper },
  )
}

/** Mesmo caminho de `RequestWorkbench.openInlineRequest`. */
function openInlineRequest(result: ReturnType<typeof renderTabs>['result']) {
  act(() => result.current.openTabs.closeRunLogPreview())
  act(() =>
    result.current.workbench.openFlowNodeRequest({ flowId: 'flow-1', nodeId: 'node-1' }, 'Avulsa', emptyRequestContent('rest')),
  )
}

describe('fechar a aba de requisição ativa', () => {
  it('volta ao flow de origem ao fechar a requisição avulsa, sem cair no editor vazio', () => {
    const { result } = renderTabs()
    act(() => result.current.openTabs.openFlow('flow-1'))
    openInlineRequest(result)
    const inlineTabId = result.current.workbench.activeTabId!
    expect(result.current.openTabs.activeOpenTab).toEqual({ kind: 'request', id: inlineTabId })

    act(() => result.current.openTabs.closeOpenTab(inlineTabId))

    expect(result.current.openTabs.activeOpenTab).toEqual({ kind: 'flow', id: 'flow-1' })
  })

  it('volta ao flow de origem mesmo com outra requisição aberta', () => {
    const { result } = renderTabs()
    act(() => result.current.workbench.newDraftTab('graphql', 'GraphQL'))
    act(() => result.current.openTabs.openFlow('flow-1'))
    openInlineRequest(result)

    act(() => result.current.openTabs.closeOpenTab(result.current.workbench.activeTabId!))

    expect(result.current.openTabs.activeOpenTab).toEqual({ kind: 'flow', id: 'flow-1' })
  })

  it('passa a vez ao flow aberto ao fechar a última aba de requisição', () => {
    const { result } = renderTabs()
    act(() => result.current.openTabs.openFlow('flow-1'))
    act(() => result.current.workbench.newDraftTab('rest', 'REST'))
    act(() => result.current.openTabs.selectOpenTab(result.current.workbench.activeTabId!))

    act(() => result.current.openTabs.closeOpenTab(result.current.workbench.activeTabId!))

    expect(result.current.openTabs.activeOpenTab).toEqual({ kind: 'flow', id: 'flow-1' })
  })

  it('mantém outra aba de requisição ativa quando ela existe', () => {
    const { result } = renderTabs()
    act(() => result.current.workbench.newDraftTab('rest', 'Primeira'))
    const firstId = result.current.workbench.activeTabId!
    act(() => result.current.workbench.newDraftTab('rest', 'Segunda'))

    act(() => result.current.openTabs.closeOpenTab(result.current.workbench.activeTabId!))

    expect(result.current.openTabs.activeOpenTab).toEqual({ kind: 'request', id: firstId })
  })
})

const update: AppNotification = {
  id: 'update:2.0.0',
  kind: 'update',
  date: '2026-10-01',
  title: { 'pt-BR': 'Alcy 2.0.0 disponível', en: 'Alcy 2.0.0 available' },
  message: { 'pt-BR': 'Nova versão.', en: 'New version.' },
  details: { 'pt-BR': '## Novidades', en: '## What is new' },
}

describe('aba de detalhes da notificação', () => {
  it('abre uma única aba por notificação, ativa e nomeada pelo título', () => {
    const { result } = renderTabs()
    act(() => result.current.workbench.newDraftTab('rest', 'REST'))

    act(() => result.current.openTabs.openNotification(update))
    act(() => result.current.openTabs.openNotification(update))

    expect(result.current.openTabs.activeOpenTab).toEqual({ kind: 'notification', id: 'notification:update:2.0.0' })
    expect(result.current.openTabs.descriptors.filter((tab) => tab.kind === 'notification')).toEqual([
      { id: 'notification:update:2.0.0', kind: 'notification', label: 'Alcy 2.0.0 disponível', dirty: false, preview: false, fixed: false },
    ])
  })

  it('volta à requisição ao selecioná-la e retoma a aba depois', () => {
    const { result } = renderTabs()
    act(() => result.current.workbench.newDraftTab('rest', 'REST'))
    const requestId = result.current.workbench.activeTabId!
    act(() => result.current.openTabs.openNotification(update))

    act(() => result.current.openTabs.selectOpenTab(requestId))
    expect(result.current.openTabs.activeOpenTab).toEqual({ kind: 'request', id: requestId })

    act(() => result.current.openTabs.selectOpenTab('notification:update:2.0.0'))
    expect(result.current.openTabs.activeOpenTab).toEqual({ kind: 'notification', id: 'notification:update:2.0.0' })
  })

  it('sai do primeiro plano ao abrir um flow e some ao ser fechada', () => {
    const { result } = renderTabs()
    act(() => result.current.openTabs.openNotification(update))
    act(() => result.current.openTabs.openFlow('flow-1'))
    expect(result.current.openTabs.activeOpenTab).toEqual({ kind: 'flow', id: 'flow-1' })

    act(() => result.current.openTabs.selectOpenTab('notification:update:2.0.0'))
    act(() => result.current.openTabs.closeOpenTab('notification:update:2.0.0'))

    expect(result.current.openTabs.notificationTabs).toEqual([])
    expect(result.current.openTabs.activeOpenTab).toEqual({ kind: 'flow', id: 'flow-1' })
  })

  it('passa a vez à aba da notificação ao fechar a última requisição', () => {
    const { result } = renderTabs()
    act(() => result.current.openTabs.openNotification(update))
    act(() => result.current.openTabs.closeRunLogPreview())
    act(() => result.current.workbench.newDraftTab('rest', 'REST'))

    act(() => result.current.openTabs.closeOpenTab(result.current.workbench.activeTabId!))

    expect(result.current.openTabs.activeOpenTab).toEqual({ kind: 'notification', id: 'notification:update:2.0.0' })
  })
})

describe('abas fixadas', () => {
  it('mostra as fixadas primeiro, na ordem em que estavam', () => {
    const { result } = renderTabs()
    act(() => result.current.workbench.newDraftTab('rest', 'A'))
    act(() => result.current.workbench.newDraftTab('rest', 'B'))
    act(() => result.current.workbench.newDraftTab('rest', 'C'))
    const [a, b, c] = result.current.workbench.tabs.map((tab) => tab.id)

    act(() => result.current.openTabs.toggleFixOpenTab(c))
    act(() => result.current.openTabs.toggleFixOpenTab(b))

    expect(result.current.openTabs.descriptors.map((tab) => tab.id)).toEqual([b, c, a])
    expect(result.current.openTabs.descriptors.map((tab) => tab.fixed)).toEqual([true, true, false])

    act(() => result.current.openTabs.toggleFixOpenTab(b))
    expect(result.current.openTabs.descriptors.map((tab) => tab.id)).toEqual([c, a, b])
  })

  it('fecha só as não fixadas, incluindo flows, e mantém uma fixada ativa', () => {
    const { result } = renderTabs()
    act(() => result.current.workbench.newDraftTab('rest', 'A'))
    act(() => result.current.workbench.newDraftTab('rest', 'B'))
    const [a] = result.current.workbench.tabs.map((tab) => tab.id)
    act(() => result.current.openTabs.openFlow('flow-1'))
    act(() => result.current.openTabs.toggleFixOpenTab(a))

    act(() => result.current.openTabs.closeUnfixedOpenTabs())

    expect(result.current.openTabs.descriptors.map((tab) => tab.id)).toEqual([a])
    expect(result.current.openTabs.activeOpenTab).toEqual({ kind: 'request', id: a })
  })

  it('mantém um flow fixado e o ativa quando nenhuma requisição sobra', () => {
    const { result } = renderTabs()
    act(() => result.current.workbench.newDraftTab('rest', 'A'))
    act(() => result.current.openTabs.openFlow('flow-1'))
    act(() => result.current.openTabs.toggleFixOpenTab('flow-1'))

    act(() => result.current.openTabs.closeUnfixedOpenTabs())

    expect(result.current.openTabs.descriptors.map((tab) => tab.id)).toEqual(['flow-1'])
    expect(result.current.openTabs.activeOpenTab).toEqual({ kind: 'flow', id: 'flow-1' })
  })
})

describe('seleção múltipla de abas', () => {
  it('fecha só as abas escolhidas, inclusive de tipos diferentes', () => {
    const { result } = renderTabs()
    act(() => result.current.workbench.newDraftTab('rest', 'A'))
    act(() => result.current.workbench.newDraftTab('rest', 'B'))
    act(() => result.current.workbench.newDraftTab('rest', 'C'))
    const [a, b, c] = result.current.workbench.tabs.map((tab) => tab.id)
    act(() => result.current.openTabs.openFlow('flow-1'))

    act(() => result.current.openTabs.closeOpenTabs([b, 'flow-1']))

    expect(result.current.openTabs.descriptors.map((tab) => tab.id)).toEqual([a, c])
    expect(result.current.openTabs.activeOpenTab).toEqual({ kind: 'request', id: c })
  })

  it('move o grupo para junto da aba alvo mantendo a ordem relativa', () => {
    const { result } = renderTabs()
    ;['A', 'B', 'C', 'D'].forEach((name) => act(() => result.current.workbench.newDraftTab('rest', name)))
    const [a, b, c, d] = result.current.workbench.tabs.map((tab) => tab.id)

    act(() => result.current.openTabs.reorderOpenTabsGroup([a, c], d, 'after'))
    expect(result.current.openTabs.descriptors.map((tab) => tab.id)).toEqual([b, d, a, c])

    act(() => result.current.openTabs.reorderOpenTabsGroup([a, c], b, 'before'))
    expect(result.current.openTabs.descriptors.map((tab) => tab.id)).toEqual([a, c, b, d])
  })

  it('não mistura fixadas e não fixadas ao mover o grupo', () => {
    const { result } = renderTabs()
    ;['A', 'B', 'C'].forEach((name) => act(() => result.current.workbench.newDraftTab('rest', name)))
    const [a, b, c] = result.current.workbench.tabs.map((tab) => tab.id)
    act(() => result.current.openTabs.toggleFixOpenTab(c))

    act(() => result.current.openTabs.reorderOpenTabsGroup([a, b], c, 'after'))

    expect(result.current.openTabs.descriptors.map((tab) => tab.id)).toEqual([c, a, b])
  })
})

describe('fechar a aba ativa de mock server', () => {
  it('passa a vez ao mock server vizinho, sem abrir o editor de requisição vazio', () => {
    const { result } = renderTabs()
    act(() => result.current.openTabs.openMockServer('users', 'Usuários'))
    act(() => result.current.openTabs.openMockServer('orders', 'Pedidos'))

    act(() => result.current.openTabs.closeOpenTab('mock-server:orders'))
    expect(result.current.openTabs.activeOpenTab).toEqual({ kind: 'mockServer', id: 'mock-server:users' })

    act(() => result.current.openTabs.openMockServer('orders', 'Pedidos'))
    act(() => result.current.openTabs.selectOpenTab('mock-server:users'))
    act(() => result.current.openTabs.closeOpenTab('mock-server:users'))
    expect(result.current.openTabs.activeOpenTab).toEqual({ kind: 'mockServer', id: 'mock-server:orders' })
  })

  it('mantém a aba exibida ao fechar um mock server que não está ativo', () => {
    const { result } = renderTabs()
    act(() => result.current.openTabs.openMockServer('users', 'Usuários'))
    act(() => result.current.openTabs.openFlow('flow-1'))

    act(() => result.current.openTabs.closeOpenTab('mock-server:users'))

    expect(result.current.openTabs.activeOpenTab).toEqual({ kind: 'flow', id: 'flow-1' })
  })

  it('não deixa aba ativa ao fechar o último mock server', () => {
    const { result } = renderTabs()
    act(() => result.current.openTabs.openMockServer('users', 'Usuários'))

    act(() => result.current.openTabs.closeOpenTab('mock-server:users'))

    expect(result.current.openTabs.descriptors).toEqual([])
    expect(result.current.openTabs.activeOpenTab).toBeNull()
  })
})
