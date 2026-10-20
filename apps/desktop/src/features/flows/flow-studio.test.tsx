import { useState, type ReactNode } from 'react'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import { LANGUAGE_STORAGE_KEY } from '../../shared/i18n/translations'
import { ShortcutsProvider } from '../../shared/shortcuts/ShortcutsProvider'
import { ToastProvider } from '../../shared/ui/Toast'
import { FlowMappingProvider } from './flow-mapping'
import { FLOW_REFERENCE_MIME, referenceFromPointer, useFlowMapping } from './flow-reference'
import { FlowOutputExplorer } from './FlowOutputExplorer'
import { FlowRequestEditor } from './FlowRequestEditor'
import { emptyRequestContent } from '../request-workbench/collection-tree'
import { contentOf, isTabDirty, useWorkbenchState } from '../request-workbench/use-workbench-state'
import { availableNodePosition } from './new-node-position'
import { FlowTabs } from './FlowTabs'
import { RunLogPanel } from './RunLogPanel'
import { inspectFlowOutput, cancelFlowOutputQuery } from '../../bindings/inspect-flow-output'

vi.mock('../../bindings/inspect-flow-output', () => ({ inspectFlowOutput: vi.fn(), cancelFlowOutputQuery: vi.fn().mockResolvedValue(undefined) }))

function StudioProviders({ children }: { children: ReactNode }) {
  return <LanguageProvider><ShortcutsProvider><ToastProvider>{children}</ToastProvider></ShortcutsProvider></LanguageProvider>
}

function MappingField() {
  const [value, setValue] = useState('Bearer ')
  const { insert } = useFlowMapping()
  return <><div data-flow-fields><input aria-label="Target" value={value} onChange={(event) => setValue(event.target.value)} /></div><button onClick={() => insert('{{nodes.login.response.body.token}}')}>Insert</button></>
}

beforeEach(() => {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en')
  vi.mocked(inspectFlowOutput).mockReset()
})

describe('flow data mapping', () => {
  it('positions new cards without overlapping existing measured nodes', () => {
    const position = { x: 360, y: 0 }
    const next = availableNodePosition(position, [{ position: { x: 360, y: 0 }, measured: { width: 300, height: 400 } }, { position: { x: 360, y: 500 }, measured: { width: 300, height: 200 } }])
    expect(next).toEqual({ x: 368, y: 736 })
    expect(position).toEqual({ x: 360, y: 0 })
  })
  it('converts JSON pointers using execution syntax and rejects unrepresentable keys', () => {
    expect(referenceFromPointer('login', '/users/0/id')).toBe('{{nodes.login.response.body.users.0.id}}')
    expect(referenceFromPointer('wait', '/a~1b/~0key', 'request')).toBe('{{nodes.wait.request.body.a/b.~key}}')
    expect(referenceFromPointer('login', '/key.with.dots')).toBeNull()
    expect(referenceFromPointer('login', '/')).toBeNull()
    expect(referenceFromPointer('login', '/{{name}}')).toBeNull()
  })

  it('inserts into the selected field without replacing its surrounding text', () => {
    render(<StudioProviders><FlowMappingProvider><MappingField /></FlowMappingProvider></StudioProviders>)
    const field = screen.getByRole('textbox', { name: 'Target' }) as HTMLInputElement
    act(() => { field.focus(); field.setSelectionRange(7, 7) })
    fireEvent.click(screen.getByText('Insert'))
    expect(field.value).toBe('Bearer {{nodes.login.response.body.token}}')
  })

  it('supports dropping a reference and completing a partial template with the keyboard', async () => {
    render(<StudioProviders><FlowMappingProvider references={['{{token}}']}><MappingField /></FlowMappingProvider></StudioProviders>)
    const field = screen.getByRole('textbox', { name: 'Target' }) as HTMLInputElement
    act(() => { field.focus(); field.setSelectionRange(7, 7) })
    fireEvent.drop(field, { dataTransfer: { getData: (type: string) => type === FLOW_REFERENCE_MIME ? '{{token}}' : '', types: [FLOW_REFERENCE_MIME] } })
    expect(field.value).toBe('Bearer {{token}}')
    fireEvent.input(field, { target: { value: '{{tok' } })
    await screen.findByRole('option', { name: '{{token}}' })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(field.value).toBe('{{token}}')
  })

  it('disables insertion into a field belonging to a previously selected node', () => {
    const { rerender } = render(<StudioProviders><FlowMappingProvider scopeKey="a"><MappingField /></FlowMappingProvider></StudioProviders>)
    const field = screen.getByRole('textbox', { name: 'Target' }) as HTMLInputElement
    act(() => field.focus())
    rerender(<StudioProviders><FlowMappingProvider scopeKey="b"><MappingField /></FlowMappingProvider></StudioProviders>)
    fireEvent.click(screen.getByText('Insert'))
    expect(field.value).toBe('Bearer ')
  })
})

describe('flow output explorer', () => {
  it('loads only the requested page and cancels obsolete queries', async () => {
    const output = { statusCode: 200, durationMs: 4, sizeBytes: 2_000_000, headers: [], body: '', bodyEncoding: 'text' as const, truncated: true }
    vi.mocked(inspectFlowOutput).mockImplementation(async (input) => ({ output, availability: 'available', revision: '3', page: { kind: 'array', preview: '', entries: [{ key: input.cursor ? '100' : '0', pointer: input.cursor ? '/100' : '/0', kind: 'number', preview: input.cursor ? '100' : '0' }], total: 200 }, text: null, nextCursor: input.cursor ? null : 'next-page' }))
    const { rerender } = render(<StudioProviders><FlowOutputExplorer rootPath="/workspace" flowExecutionId="run" nodeId="users" /></StudioProviders>)
    await screen.findByRole('treeitem')
    expect(inspectFlowOutput).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'users', cursor: null, pointer: '' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(inspectFlowOutput).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'next-page' })))
    await waitFor(() => expect(screen.getAllByRole('treeitem')).toHaveLength(1))
    expect(cancelFlowOutputQuery).toHaveBeenCalled()
    rerender(<StudioProviders><FlowOutputExplorer rootPath="/workspace" flowExecutionId="run" nodeId="users" version={1} /></StudioProviders>)
    await waitFor(() => expect(inspectFlowOutput).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null })))
  })

  it('shows an explicit empty state before execution without invoking native inspection', () => {
    render(<StudioProviders><FlowOutputExplorer rootPath="/workspace" flowExecutionId={null} nodeId="users" /></StudioProviders>)
    expect(screen.getByText('Run the flow to explore this node’s data.')).toBeInTheDocument()
    expect(inspectFlowOutput).not.toHaveBeenCalled()
  })
})

describe('embedded flow request editor', () => {
  it('opens templated requests with differently ordered raw body fields and previews their variables', () => {
    const content = { ...emptyRequestContent('rest'), endpointUrl: '{{baseUrl}}/users', body: { type: 'raw' as const, rawLanguage: 'json' as const, content: '{"id":"{{userId}}"}' } }
    render(<StudioProviders><FlowRequestEditor rootPath="/workspace" content={content} variables={[{ name: 'baseUrl', value: 'https://api.test', sensitive: false }]} targetLabel="Inline request" dirty={false} onChange={vi.fn()} onSave={vi.fn()} onDiscard={vi.fn()} /></StudioProviders>)
    const variable = document.querySelector('.var-token--known')!
    fireEvent.mouseEnter(variable)
    fireEvent.click(variable)
    expect(screen.getByText('https://api.test')).toHaveClass('var-preview-value')
    expect(screen.getByLabelText('Endpoint')).toHaveValue('{{baseUrl}}/users')
  })

  it('opens URLs with empty query names and synchronizes external endpoint changes without looping', () => {
    const base = { ...emptyRequestContent('rest'), endpointUrl: '{{baseUrl}}/users?=value&&page=2&' }
    const onChange = vi.fn()
    const editor = (content: typeof base) => <StudioProviders><FlowRequestEditor rootPath="/workspace" content={content} variables={[]} targetLabel="Inline request" dirty={false} onChange={onChange} onSave={vi.fn()} onDiscard={vi.fn()} /></StudioProviders>
    const { rerender } = render(editor(base))
    fireEvent.click(screen.getByRole('tab', { name: 'Parameters' }))
    expect(screen.getAllByRole('textbox', { name: 'Name' }).map((field) => (field as HTMLInputElement).value)).toEqual(['', '', 'page', ''])
    rerender(editor({ ...base, endpointUrl: '{{baseUrl}}/users?&limit=10' }))
    expect(screen.getAllByRole('textbox', { name: 'Name' }).map((field) => (field as HTMLInputElement).value)).toEqual(['', 'limit'])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('preserves row identity when equivalent body fields arrive in another order and updates changed external values', () => {
    const base = { ...emptyRequestContent('rest'), body: { type: 'urlencoded' as const, fields: [{ name: 'userId', value: '{{userId}}', enabled: true }] } }
    const editor = (content: typeof base) => <StudioProviders><FlowRequestEditor rootPath="/workspace" content={content} variables={[]} targetLabel="Inline request" dirty={false} onChange={vi.fn()} onSave={vi.fn()} onDiscard={vi.fn()} /></StudioProviders>
    const { container, rerender } = render(editor(base))
    const inputs = [...container.querySelectorAll('input')]
    const reordered = { ...base, body: { type: 'urlencoded' as const, fields: [{ enabled: true, value: '{{userId}}', name: 'userId' }] } }
    rerender(editor(reordered))
    const updatedInputs = [...container.querySelectorAll('input')]
    expect(updatedInputs).toHaveLength(inputs.length)
    updatedInputs.forEach((field, index) => expect(field).toBe(inputs[index]))
    rerender(editor({ ...base, body: { type: 'urlencoded', fields: [{ name: 'userId', value: 'updated', enabled: true }] } }))
    expect(container.querySelector('input[value="updated"]')).toBeInTheDocument()
  })

  it('shares an existing workbench draft and does not mark edits made during saving as saved', () => {
    const { result } = renderHook(() => useWorkbenchState([], '/workspace', []))
    const content = { ...emptyRequestContent('rest'), endpointUrl: 'https://api.test/a' }
    const request = { id: 'request', name: 'Users', content }
    act(() => result.current.openRequest(request.id, content, request.name))
    const id = result.current.activeTabId!
    const savedSnapshot = { ...content, endpointUrl: 'https://api.test/b' }
    act(() => result.current.editFlowRequestDraft(request, savedSnapshot))
    expect(result.current.tabs).toHaveLength(1)
    expect(result.current.activeTabId).toBe(id)
    act(() => result.current.editFlowRequestDraft(request, { ...content, endpointUrl: 'https://api.test/c' }))
    act(() => result.current.markContentSaved(id, savedSnapshot))
    expect(contentOf(result.current.tabs[0]).endpointUrl).toBe('https://api.test/c')
    expect(result.current.tabs[0].savedContent.endpointUrl).toBe('https://api.test/b')
    expect(isTabDirty(result.current.tabs[0])).toBe(true)
  })

  it('keeps inline drafts associated with their node when opening the same request in a tab', () => {
    const { result } = renderHook(() => useWorkbenchState([], '/workspace', []))
    const content = emptyRequestContent('rest')
    const ref = { flowId: 'flow', nodeId: 'inline' }
    act(() => result.current.editFlowRequestDraft({ id: 'request', name: 'Inline', content }, { ...content, endpointUrl: 'https://api.test/draft' }, ref))
    expect(result.current.activeTabId).toBeNull()
    act(() => result.current.openFlowNodeRequest(ref, 'Inline', content))
    expect(result.current.tabs).toHaveLength(1)
    expect(result.current.activeTab.endpointUrl).toBe('https://api.test/draft')
  })
  it('keeps edits as a draft until Save and allows adding blank query parameters', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    function Editor() {
      const [content, setContent] = useState({ ...emptyRequestContent('rest'), endpointUrl: 'https://api.test/users' })
      return <FlowRequestEditor rootPath="/workspace" content={content} variables={[]} targetLabel="Collection / Users" dirty onChange={setContent} onSave={save} onDiscard={() => undefined} />
    }
    render(<StudioProviders><Editor /></StudioProviders>)
    fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'https://api.test/teams' } })
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: 'Parameters' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add param' }))
    expect(screen.getAllByRole('textbox', { name: 'Name' })).toHaveLength(1)
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'page' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Value' }), { target: { value: '2' } })
    expect(screen.getByLabelText('Endpoint')).toHaveValue('https://api.test/teams?page=2')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
  })
})

describe('flow keyboard navigation and large execution logs', () => {
  it('activates tabs with arrow keys and keeps one tab stop', () => {
    function Tabs() { const [tab, setTab] = useState('config'); return <FlowTabs items={[{ id: 'config', label: 'Configuration' }, { id: 'data', label: 'Data' }]} value={tab} onChange={setTab} label="Node" /> }
    render(<Tabs />)
    const first = screen.getByRole('tab', { name: 'Configuration' })
    act(() => first.focus())
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Data' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: 'Data' })).toHaveAttribute('aria-selected', 'true')
    expect(first).toHaveAttribute('tabindex', '-1')
  })

  it('mounts a bounded window of execution entries', () => {
    const entries = Array.from({ length: 10_000 }, (_, index) => ({ nodeId: `node-${index}`, startedAtMs: 0, finishedAtMs: 1, status: { status: 'completed' as const, message: null } }))
    const { container } = render(<StudioProviders><RunLogPanel entries={entries} nodeInfo={{}} runStartedAtMs={0} flowExecutionId={null} isRunning={false} /></StudioProviders>)
    expect(container.querySelectorAll('.flow-run-log-row').length).toBeLessThan(30)
    fireEvent.scroll(container.querySelector('.flow-run-log-list')!, { target: { scrollTop: 44 * 500 } })
    expect(container.querySelector('[aria-posinset="501"]')).not.toBeNull()
    expect(container.querySelectorAll('.flow-run-log-row').length).toBeLessThan(30)
  })
})
