import type { ReactNode } from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import { ShortcutsProvider } from '../../shared/shortcuts/ShortcutsProvider'
import { ToastProvider } from '../../shared/ui/Toast'
import { AgentResourceBridge } from '../agent/agent-resource-bridge'
import { FlowCanvas } from './FlowCanvas'
import { createFlow, dtoFromFlow } from './use-flows-state'
import { patchFlow } from '../agent/agent-resource-tools'
import { releaseClosedFlowSessions } from './flow-run-session'
import { executeFlow } from '../../bindings/execute-flow'
import { cancelFlow } from '../../bindings/cancel-flow'

vi.mock('../../bindings/mock-servers', () => ({ listMockServers: vi.fn(async () => ({ ok: true, value: { servers: [] } })), getMockServer: vi.fn() }))
vi.mock('../../bindings/execute-flow', () => ({ executeFlow: vi.fn(async () => ({ ok: true })) }))
vi.mock('../../bindings/cancel-flow', () => ({ cancelFlow: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../bindings/flow-forms', () => ({ releaseFlowRun: vi.fn().mockResolvedValue(undefined), submitFlowForm: vi.fn(), listFlowFormOptions: vi.fn() }))

function wrapper({ children }: { children: ReactNode }) {
  return <LanguageProvider><ShortcutsProvider><ToastProvider>{children}</ToastProvider></ShortcutsProvider></LanguageProvider>
}

afterEach(() => { releaseClosedFlowSessions('/canvas-agent-tests', []); vi.clearAllMocks() })

describe('flow agent controller', () => {
  it('applies edits to the mounted canvas and unregisters its controller when unmounted', async () => {
    const flow = createFlow('Example')
    const bridge = new AgentResourceBridge('/canvas-agent-tests')
    const view = render(<FlowCanvas agentBridge={bridge} rootPath={bridge.rootPath} flow={flow} collections={[]} environmentVariables={[]} onChange={vi.fn()} />, { wrapper })
    await act(async () => {})
    const next = patchFlow(dtoFromFlow(flow), { upsertNodes: [{ id: 'log', kind: 'log', message: 'Hello' }] })
    act(() => bridge.get('flow', flow.id)!.replace(next))
    expect(bridge.get('flow', flow.id)!.read().nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'log', message: 'Hello' })]))
    view.unmount()
    expect(bridge.get('flow', flow.id)).toBeUndefined()
  })

  it('opens the initial form and leaves its submission to the user', async () => {
    const flow = createFlow('With form')
    flow.nodes = [{ id: 'start', kind: 'start', form: { title: 'Operator input', description: 'Review before running', sections: [] }, position: { x: 0, y: 0 } }]
    const bridge = new AgentResourceBridge('/canvas-agent-tests')
    render(<FlowCanvas agentBridge={bridge} rootPath={bridge.rootPath} flow={flow} collections={[]} environmentVariables={[]} onChange={vi.fn()} />, { wrapper })
    let result: unknown
    await act(async () => { result = await bridge.get('flow', flow.id)!.run() })
    expect(result).toMatchObject({ status: 'awaitingInput' })
    expect(screen.getByText('Operator input')).toBeInTheDocument()
    expect(executeFlow).not.toHaveBeenCalled()
  })

  it('returns a native execution id and cancels through the existing run controls', async () => {
    const flow = createFlow('Run')
    const bridge = new AgentResourceBridge('/canvas-agent-tests')
    render(<FlowCanvas agentBridge={bridge} rootPath={bridge.rootPath} flow={flow} collections={[]} environmentVariables={[]} onChange={vi.fn()} />, { wrapper })
    let result: unknown
    await act(async () => { result = await bridge.get('flow', flow.id)!.run() })
    expect(result).toMatchObject({ status: 'starting', flowExecutionId: expect.any(String) })
    expect(executeFlow).toHaveBeenCalledOnce()
    act(() => bridge.get('flow', flow.id)!.cancel())
    expect(cancelFlow).toHaveBeenCalledWith(expect.any(String))
  })
})
