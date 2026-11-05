import { useState, type ReactNode } from 'react'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import { ShortcutsProvider } from '../../shared/shortcuts/ShortcutsProvider'
import { ToastProvider } from '../../shared/ui/Toast'
import { EditorView } from '@codemirror/view'
import { installButtonMousedownWorkaround } from '../../shared/button-mousedown-workaround'
import { LANGUAGE_STORAGE_KEY } from '../../shared/i18n/translations'
import { inspectFlowOutput, cancelFlowOutputQuery } from '../../bindings/inspect-flow-output'
import { emptyRequestContent } from '../request-workbench/collection-tree'
import { contentOf, isTabDirty, useWorkbenchState } from '../request-workbench/use-workbench-state'
import { useOpenTabs } from '../request-workbench/use-open-tabs'
import { RequestBodyPanel } from '../request-workbench/components/RequestBodyPanel'
import type { FlowNodeState } from './flows.types'
import { FlowMappingProvider } from './flow-mapping'
import { NodeIdentifierField } from './NodeIdentifierField'
import { QuickNodeEdit } from './QuickNodeEdit'
import { FlowOutputExplorer } from './FlowOutputExplorer'
import type { SimpleNodeKindState } from './flows.types'
import { availableNodeIdentifier, identifierError, renameGraphNode } from './node-identifiers'

vi.mock('../../bindings/inspect-flow-output', () => ({ inspectFlowOutput: vi.fn(), cancelFlowOutputQuery: vi.fn().mockResolvedValue(undefined) }))
const wrapper = ({ children }: { children: ReactNode }) => <LanguageProvider><ShortcutsProvider><ToastProvider>{children}</ToastProvider></ShortcutsProvider></LanguageProvider>
function Field({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return <div data-flow-fields><textarea aria-label="Target" value={value} onChange={(event) => setValue(event.target.value)} /></div>
}
beforeEach(() => { localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en'); vi.mocked(inspectFlowOutput).mockReset(); vi.mocked(cancelFlowOutputQuery).mockClear() })

describe('readable flow identifiers', () => {
  it('generates readable unique names and validates explicit renames', () => {
    expect(availableNodeIdentifier('Buscar Usuários', [{ id: 'buscar_usuarios' }, { id: 'buscar_usuarios_2' }])).toBe('buscar_usuarios_3')
    expect(availableNodeIdentifier('mockWaitRequest', [])).toBe('mock_wait_request')
    expect(availableNodeIdentifier('123', [])).toBe('node_123')
    expect(identifierError('login', 'old', [{ id: 'login' }])).toBe('duplicate')
    expect(identifierError('login.body', 'old', [])).toBe('invalid')
  })
  it('renames graph dependencies and template references without changing unrelated values', () => {
    const nodes: FlowNodeState[] = [
      { id: 'old', kind: 'request', requestId: 'collection-request', position: { x: 0, y: 0 } },
      { id: 'display', kind: 'display', template: '{{ nodes.old.response.body.token }} / {{nodes.older.response.status}} / old', position: { x: 0, y: 0 } },
      { id: 'wait', kind: 'mockWaitRequest', startNodeId: 'old', routeId: 'old', timeoutMs: '5', position: { x: 0, y: 0 } },
      { id: 'inline', kind: 'inlineRequest', request: { id: 'request', name: 'Old', protocol: 'rest', content: { ...emptyRequestContent('rest'), headers: [{ name: 'Authorization', value: 'Bearer {{nodes.old.response.body.token}}', enabled: true }] } }, position: { x: 0, y: 0 } },
      { id: 'load', kind: 'load', loadKind: 'request', label: 'Old', config: '{"url":"{{nodes.old.response.body.url}}"}', position: { x: 0, y: 0 } },
    ]
    const graph = renameGraphNode(nodes, [{ id: 'edge', sourceNodeId: 'old', targetNodeId: 'display' }], 'old', 'login')
    expect(graph.nodes[0].id).toBe('login')
    expect(graph.nodes[1]).toMatchObject({ template: '{{ nodes.login.response.body.token }} / {{nodes.older.response.status}} / old' })
    expect(graph.nodes[2]).toMatchObject({ startNodeId: 'login', routeId: 'old' })
    expect(graph.nodes[3]).toMatchObject({ request: { content: { headers: [{ value: 'Bearer {{nodes.login.response.body.token}}' }] } } })
    expect(graph.nodes[4]).toMatchObject({ config: '{"url":"{{nodes.login.response.body.url}}"}' })
    expect(graph.edges[0]).toMatchObject({ sourceNodeId: 'login', targetNodeId: 'display' })
    expect(nodes[0].id).toBe('old')
  })
  it('only applies an explicit valid rename', () => {
    const rename = vi.fn()
    render(<NodeIdentifierField nodeId="uuid" nodes={[{ id: 'uuid' }, { id: 'users' }]} onRename={rename} />, { wrapper })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'users' } })
    expect(screen.getByRole('alert')).toHaveTextContent('already uses')
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'login' } })
    expect(rename).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(rename).toHaveBeenCalledWith('login')
  })
  it('allows removing a digit from an existing numeric-leading UUID', () => {
    const rename = vi.fn()
    const previous = '8562262d-1dec-4818-878a-ca6de7329e8c'
    const next = previous.slice(0, 2) + previous.slice(3)
    render(<NodeIdentifierField nodeId={previous} nodes={[{ id: previous }]} onRename={rename} />, { wrapper })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: next } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Rename' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(rename).toHaveBeenCalledWith(next)
    expect(identifierError('123', previous, [])).toBeNull()
    expect(identifierError('', previous, [])).toBe('invalid')
    expect(identifierError(next, previous, [{ id: next }])).toBe('duplicate')
  })
  it('keeps inline draft content, saved snapshots and tabs attached after a rename', () => {
    const { result } = renderHook(() => useWorkbenchState([], '/workspace', []))
    const content = { ...emptyRequestContent('rest'), endpointUrl: 'https://api.test/{{nodes.old.response.body.id}}' }
    act(() => result.current.openFlowNodeRequest({ flowId: 'flow', nodeId: 'old' }, 'Login', content))
    const id = result.current.activeTabId!
    act(() => result.current.editFlowRequestDraft({ id: 'request', name: 'Login', content }, { ...content, endpointUrl: `${content.endpointUrl}/draft` }, { flowId: 'flow', nodeId: 'old' }))
    act(() => result.current.renameFlowNode('flow', 'old', 'login'))
    expect(result.current.tabs[0].id).toBe(id)
    expect(result.current.tabs[0].flowNodeRef).toEqual({ flowId: 'flow', nodeId: 'login' })
    expect(contentOf(result.current.tabs[0]).endpointUrl).toBe('https://api.test/{{nodes.login.response.body.id}}/draft')
    expect(result.current.tabs[0].savedContent.endpointUrl).toBe('https://api.test/{{nodes.login.response.body.id}}')
    expect(isTabDirty(result.current.tabs[0])).toBe(true)
  })
  it('preserves and reopens the same inline mock tab after a rename', () => {
    const { result } = renderHook(() => { const workbench = useWorkbenchState([], '/workspace', []); return useOpenTabs(workbench, { flows: [] }) }, { wrapper })
    act(() => result.current.openInlineMockServer('flow', 'old', 'Mock'))
    const tab = result.current.mockServerTabs[0]
    act(() => result.current.updateMockServerTab(tab.serverId, { dirty: true }))
    act(() => result.current.renameFlowNode('flow', 'old', 'mock'))
    act(() => result.current.openInlineMockServer('flow', 'mock', 'Mock'))
    expect(result.current.mockServerTabs).toHaveLength(1)
    expect(result.current.mockServerTabs[0]).toMatchObject({ id: tab.id, dirty: true, flowNodeRef: { flowId: 'flow', nodeId: 'mock' } })
  })
})

describe('flow reference completion', () => {
  it('selects suggestions by pointer with the native focus workaround and keeps the quick editor open', async () => {
    const uninstall = installButtonMousedownWorkaround()
    try {
      function Quick() {
        const [config, setConfig] = useState<SimpleNodeKindState>({ kind: 'setVariables', assignments: [{ name: 'token', operation: 'set', value: '{{access' }] })
        return <FlowMappingProvider scopeKey="local" references={['{{access_token}}']}><QuickNodeEdit nodeId="local" config={config} onChange={(next) => { if (next.kind !== 'if') setConfig(next) }} /></FlowMappingProvider>
      }
      render(<Quick />, { wrapper })
      fireEvent.click(screen.getByRole('button', { name: 'Quick edit' }))
      const field = screen.getByRole('textbox', { name: 'Value' }) as HTMLInputElement
      act(() => { field.focus(); field.setSelectionRange(field.value.length, field.value.length) })
      const option = await screen.findByRole('option', { name: '{{access_token}}' })
      expect(screen.getByRole('listbox')).not.toContainElement(screen.getByText('Variables · ↑↓ navigate · Enter insert · Esc close'))
      fireEvent.pointerDown(option, { pointerType: 'mouse' })
      expect(screen.getByRole('dialog', { name: 'Quick edit' })).toBeInTheDocument()
      fireEvent.mouseDown(option)
      expect(field).toHaveValue('{{access_token}}')
      expect(field).toHaveFocus()
      expect(screen.getByRole('dialog', { name: 'Quick edit' })).toBeInTheDocument()
    } finally { uninstall() }
  })
  it('opens with Ctrl+Space and replaces a complete existing token when editing its middle', async () => {
    render(<FlowMappingProvider references={['{{token}}', '{{team}}']}><Field initial="Bearer {{tokenn}} suffix" /></FlowMappingProvider>, { wrapper })
    const field = screen.getByRole('textbox') as HTMLTextAreaElement
    act(() => { field.focus(); field.setSelectionRange(12, 12) })
    fireEvent.keyUp(field, { key: 'ArrowLeft' })
    await screen.findByRole('option', { name: '{{token}}' })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(field.value).toBe('Bearer {{token}} suffix')
    act(() => field.setSelectionRange(field.value.length, field.value.length))
    fireEvent.keyDown(field, { key: ' ', code: 'Space', ctrlKey: true })
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    fireEvent.keyDown(field, { key: 'Tab' })
    expect(field.value).toBe('Bearer {{token}} suffix{{team}}')
  })
  it('loads nested response fields after a rename without mounting a data explorer', async () => {
    vi.mocked(inspectFlowOutput).mockResolvedValue({ output: { statusCode: 200, durationMs: 1, sizeBytes: 1000, body: '', bodyEncoding: 'text', headers: [], truncated: false }, availability: 'available', revision: '1', page: { kind: 'object', preview: '', total: 1, entries: [{ key: 'token', pointer: '/auth/token', kind: 'string', preview: 'example' }] }, text: null, nextCursor: null })
    render(<FlowMappingProvider rootPath="/workspace" flowExecutionId="run" sources={[{ nodeId: 'login', snapshotNodeId: 'original-uuid', label: 'Sign in', scope: 'response' }]} references={['{{nodes.login.response.body}}']}><Field initial="{{nodes.login.response.body.auth.to" /></FlowMappingProvider>, { wrapper })
    const field = screen.getByRole('textbox')
    act(() => { (field as HTMLTextAreaElement).focus(); (field as HTMLTextAreaElement).setSelectionRange(35, 35) })
    await screen.findByRole('option', { name: '{{nodes.login.response.body.auth.token}}' })
    expect(inspectFlowOutput).toHaveBeenCalledWith(expect.objectContaining({ pointer: '/auth', query: 'to', nodeId: 'original-uuid' }))
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(field).toHaveValue('{{nodes.login.response.body.auth.token}}')
    await waitFor(() => expect(cancelFlowOutputQuery).toHaveBeenCalled())
  })
  it('keeps output inspection available after renaming while generating references with the new name', async () => {
    vi.mocked(inspectFlowOutput).mockResolvedValue({ output: { statusCode: 200, durationMs: 1, sizeBytes: 1000, body: '', bodyEncoding: 'text', headers: [], truncated: false }, availability: 'available', revision: '1', page: { kind: 'object', preview: '', total: 1, entries: [{ key: 'token', pointer: '/token', kind: 'string', preview: 'example' }] }, text: null, nextCursor: null })
    render(<FlowOutputExplorer rootPath="/workspace" flowExecutionId="run" nodeId="login" snapshotNodeId="original-uuid" />, { wrapper })
    await screen.findByRole('treeitem')
    expect(inspectFlowOutput).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'original-uuid' }))
    expect(screen.getByRole('button', { name: /nodes\.login\.response\.body\.token/ })).toBeInTheDocument()
  })
  it('completes inside a real CodeMirror editor', async () => {
    function Editor() { const [value, setValue] = useState('{{tok'); return <FlowMappingProvider references={['{{token}}']}><div data-flow-fields><RequestBodyPanel value={value} onChange={setValue} /></div><output>{value}</output></FlowMappingProvider> }
    const { container } = render(<Editor />, { wrapper })
    const field = container.querySelector<HTMLElement>('.cm-content')!
    act(() => { field.focus(); const view = EditorView.findFromDOM(field)!; view.dispatch({ selection: { anchor: view.state.doc.length } }) })
    fireEvent.keyDown(field, { key: ' ', code: 'Space', ctrlKey: true })
    await screen.findByRole('option', { name: '{{token}}' })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(container.querySelector('output')).toHaveTextContent('{{token}}')
  })
  it('switches mapping scope to a quick editor without opening an inspector', async () => {
    function Quick() { const [scope, setScope] = useState('inspector'); return <FlowMappingProvider scopeKey={scope} onTargetNodeChange={setScope} references={['{{token}}']}><div data-flow-node-id="quick"><Field initial="{{tok" /></div><output>{scope}</output></FlowMappingProvider> }
    const { container } = render(<Quick />, { wrapper })
    const field = screen.getByRole('textbox')
    act(() => { field.focus(); (field as HTMLTextAreaElement).setSelectionRange(5, 5) })
    await screen.findByRole('option', { name: '{{token}}' })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(field).toHaveValue('{{token}}')
    expect(container.querySelector('output')).toHaveTextContent('quick')
    expect(screen.queryByRole('complementary')).toBeNull()
  })
})
