import type { ReactNode } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import { ShortcutsProvider } from '../../shared/shortcuts/ShortcutsProvider'
import { ToastProvider } from '../../shared/ui/Toast'
import { FlowCanvas } from './FlowCanvas'
import { createFlow } from './use-flows-state'
import { releaseClosedLoadFlowSessions } from './load-flow-run-session'
import { releaseClosedFlowSessions } from './flow-run-session'

vi.mock('../../bindings/mock-servers', () => ({ listMockServers: vi.fn(async () => ({ ok: true, value: { servers: [] } })), getMockServer: vi.fn() }))

const ROOT = '/node-settings-tests'

function wrapper({ children }: { children: ReactNode }) { return <LanguageProvider><ShortcutsProvider><ToastProvider>{children}</ToastProvider></ShortcutsProvider></LanguageProvider> }

afterEach(() => { releaseClosedLoadFlowSessions(ROOT, []); releaseClosedFlowSessions(ROOT, []) })

describe('block settings', () => {
  function renderCanvas() {
    const flow = createFlow('Load')
    flow.executionKind = 'load'
    flow.nodes.push(
      { id: 'first', kind: 'load', loadKind: 'scenario', label: 'First', config: '{"executor":"constantVus","vus":1,"durationMs":1000}', position: { x: 300, y: 0 } },
      { id: 'second', kind: 'load', loadKind: 'scenario', label: 'Second', config: '{"executor":"constantVus","vus":1,"durationMs":1000}', position: { x: 600, y: 0 } },
    )
    const view = render(<FlowCanvas rootPath={ROOT} flow={flow} collections={[]} environmentVariables={[]} onChange={vi.fn()} />, { wrapper })
    const node = (id: string) => view.container.querySelector(`[data-id="${id}"]`) as HTMLElement
    const inspector = () => view.container.querySelector('.flow-studio-inspector')
    return { node, inspector }
  }

  it('opens on a double click, not on a single click', async () => {
    const { node, inspector } = renderCanvas()

    fireEvent.click(node('first'))
    expect(inspector()).toBeNull()

    fireEvent.doubleClick(node('first'))
    expect(inspector()).toBeVisible()
    await act(async () => {})
  })

  it('follows a single click on another block once open', async () => {
    const { node, inspector } = renderCanvas()
    fireEvent.doubleClick(node('first'))
    expect(inspector()).toHaveAttribute('data-flow-node-id', 'first')

    fireEvent.click(node('second'))
    expect(inspector()).toHaveAttribute('data-flow-node-id', 'second')
    await act(async () => {})
  })
})
