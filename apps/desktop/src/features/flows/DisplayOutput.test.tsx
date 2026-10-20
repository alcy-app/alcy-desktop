import type { ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import { LANGUAGE_STORAGE_KEY } from '../../shared/i18n/translations'
import { ToastProvider } from '../../shared/ui/Toast'
import { cancelFlowOutputQuery, inspectFlowOutput } from '../../bindings/inspect-flow-output'
import type { FlowOutputFieldDto, FlowOutputInspectionDto } from '../../bindings/inspect-flow-output'
import { DisplayOutput } from './DisplayOutput'
import { DisplayValue } from './DisplayValue'
import { DisplayFormatSelect } from './DisplayFormatSelect'
import { displayBodyNodeId } from './display-output-source'

vi.mock('../../bindings/inspect-flow-output', () => ({ inspectFlowOutput: vi.fn(), cancelFlowOutputQuery: vi.fn().mockResolvedValue(undefined) }))

const wrapper = ({ children }: { children: ReactNode }) => <LanguageProvider><ToastProvider>{children}</ToastProvider></LanguageProvider>
const source = { rootPath: '/workspace', flowExecutionId: 'run', nodeId: 'users' }
const page = (text: string, nextCursor: string | null = null): FlowOutputInspectionDto => ({ output: { statusCode: 200, durationMs: 5, sizeBytes: 100_000, headers: [], body: '', bodyEncoding: 'text', truncated: true }, availability: 'available', revision: '1', page: null, text, nextCursor })
const treePage = (kind: string, entries: FlowOutputFieldDto[], total = entries.length, nextCursor: string | null = null): FlowOutputInspectionDto => ({ ...page(''), text: null, page: { kind, preview: String(total), entries, total }, nextCursor })

beforeEach(() => {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en')
  vi.mocked(inspectFlowOutput).mockReset()
  vi.mocked(cancelFlowOutputQuery).mockClear()
})

describe('Display response viewport', () => {
  it('preserves the tail of output beyond the former canvas cutoff', () => {
    const value = `${'body line\n'.repeat(200)}FINAL VALUE`
    const { container } = render(<DisplayOutput value={value} format="text" compact />, { wrapper })
    expect(container.querySelector('pre')?.textContent).toBe(value)
    expect(inspectFlowOutput).not.toHaveBeenCalled()
  })

  it('formats JSON and preserves the original data for an incompatible type', () => {
    const { container, rerender } = render(<DisplayValue value='{"ok":true}' format="json" compact />, { wrapper })
    expect(screen.getByRole('tree')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'ok true' })).toBeInTheDocument()
    rerender(<DisplayValue value="keep this text" format="number" compact />)
    expect(screen.getByRole('status')).toHaveTextContent('The output does not match')
    expect(container.querySelector('pre')).toHaveTextContent('keep this text')
    rerender(<DisplayValue value="false" format="boolean" compact />)
    expect(screen.getByRole('status')).toHaveTextContent('false')
  })

  it('renders HTML in an opaque sandbox and Markdown without raw HTML', () => {
    const html = '<script>window.bad = true</script><h1>Hello</h1>'
    const { container, rerender } = render(<DisplayValue value={html} format="html" compact />, { wrapper })
    const preview = screen.getByTitle('Response HTML preview')
    expect(preview).toHaveAttribute('srcdoc', html)
    expect(preview).toHaveAttribute('sandbox', '')
    expect(preview).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(container.querySelector('script')).toBeNull()
    rerender(<DisplayValue value={'# Hello\n<script>bad()</script>'} format="markdown" compact />)
    expect(screen.getByRole('heading', { name: 'Hello' })).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
    expect(container).toHaveTextContent('<script>bad()</script>')
  })

  it('changes presentation without bubbling a node selection click', () => {
    const change = vi.fn()
    const selectNode = vi.fn()
    render(<div onClick={selectNode}><DisplayFormatSelect value="auto" onChange={change} /></div>, { wrapper })
    const select = screen.getByRole('combobox', { name: 'Display format' })
    expect(screen.getAllByRole('option')).toHaveLength(9)
    fireEvent.click(select)
    fireEvent.change(select, { target: { value: 'json' } })
    expect(change).toHaveBeenCalledWith('json')
    expect(selectNode).not.toHaveBeenCalled()
  })

  it('reads bounded pages, releases the previous page and preserves navigation across format changes', async () => {
    vi.mocked(inspectFlowOutput).mockImplementation(async (input) => page(input.cursor ? 'Last page' : 'First page', input.cursor ? null : 'next'))
    const { container, rerender, unmount } = render(<DisplayOutput source={source} value="cut summary" format="text" compact />, { wrapper })
    await screen.findByText('First page')
    expect(inspectFlowOutput).toHaveBeenLastCalledWith(expect.objectContaining({ ...source, cursor: null, text: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('Last page')
    expect(container).not.toHaveTextContent('First page')
    expect(inspectFlowOutput).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'next' }))
    const reads = vi.mocked(inspectFlowOutput).mock.calls.length
    rerender(<DisplayOutput source={source} value="cut summary" format="markdown" compact />)
    expect(inspectFlowOutput).toHaveBeenCalledTimes(reads)
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    await screen.findByText('First page')
    unmount()
    expect(cancelFlowOutputQuery).toHaveBeenCalledTimes(3)
  })

  it('ignores a stale response after switching executions and cancels that read', async () => {
    let resolveOld!: (value: FlowOutputInspectionDto) => void
    vi.mocked(inspectFlowOutput).mockImplementation((input) => input.flowExecutionId === 'run' ? new Promise((resolve) => { resolveOld = resolve }) : Promise.resolve(page('New response')))
    const { rerender } = render(<DisplayOutput source={source} value="summary" format="text" compact />, { wrapper })
    await waitFor(() => expect(inspectFlowOutput).toHaveBeenCalledOnce())
    rerender(<DisplayOutput source={{ ...source, flowExecutionId: 'new-run' }} value="summary" format="text" compact />)
    await screen.findByText('New response')
    await act(async () => resolveOld(page('Old response')))
    expect(screen.queryByText('Old response')).not.toBeInTheDocument()
    expect(cancelFlowOutputQuery).toHaveBeenCalledWith(expect.any(String))
  })

  it('shows a retry and the masked event preview when the archive cannot be read', async () => {
    vi.mocked(inspectFlowOutput).mockRejectedValueOnce('unavailable').mockResolvedValueOnce(page('Recovered response'))
    render(<DisplayOutput source={source} value="Masked preview" format="text" compact />, { wrapper })
    await screen.findByText('Masked preview')
    expect(screen.getByRole('status')).toHaveTextContent('Full inspection unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByText('Recovered response')
  })

  it('only resolves a whole-body template to an archived source', () => {
    expect(displayBodyNodeId(' {{ nodes.users.response.body }} ')).toBe('users')
    expect(displayBodyNodeId('{{nodes.webhook.request.body}}')).toBe('webhook')
    expect(displayBodyNodeId('Response: {{nodes.users.response.body}}')).toBeNull()
    expect(displayBodyNodeId('{{nodes.users.response.body.token}}')).toBeNull()
    expect(displayBodyNodeId('{{secret}}')).toBeNull()
  })

  it('expands and collapses nested inline JSON with the mouse and arrow keys', () => {
    render(<DisplayValue value='{"address":{"city":"Sao Paulo"},"items":[{"id":42}]}' format="auto" compact />, { wrapper })
    const address = screen.getByRole('button', { name: /^address / })
    expect(screen.queryByRole('button', { name: /city/ })).not.toBeInTheDocument()
    fireEvent.click(address)
    expect(screen.getByRole('button', { name: 'city "Sao Paulo"' })).toBeInTheDocument()
    fireEvent.keyDown(address, { key: 'ArrowLeft' })
    expect(screen.queryByRole('button', { name: /city/ })).not.toBeInTheDocument()
    fireEvent.keyDown(address, { key: 'ArrowRight' })
    expect(screen.getByRole('button', { name: /city/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^items / }))
    fireEvent.click(screen.getByRole('button', { name: /^0 / }))
    expect(screen.getByRole('button', { name: 'id 42' })).toBeInTheDocument()
  })

  it('fetches nested body fields only when their arrows are expanded, using the archive revision', async () => {
    vi.mocked(inspectFlowOutput).mockImplementation(async (input) => {
      if (input.pointer === '/0') return treePage('object', [{ key: 'address', pointer: '/0/address', kind: 'object', preview: '1' }])
      if (input.pointer === '/0/address') return treePage('object', [{ key: 'city', pointer: '/0/address/city', kind: 'string', preview: 'London' }])
      return treePage('array', [{ key: '0', pointer: '/0', kind: 'object', preview: '1' }], 10_000)
    })
    render(<DisplayOutput source={source} value="truncated preview" format="auto" compact />, { wrapper })
    const item = await screen.findByRole('button', { name: /^0 / })
    expect(inspectFlowOutput).toHaveBeenCalledOnce()
    expect(inspectFlowOutput).toHaveBeenLastCalledWith(expect.objectContaining({ pointer: '', text: false }))
    fireEvent.click(item)
    const address = await screen.findByRole('button', { name: /^address / })
    expect(inspectFlowOutput).toHaveBeenLastCalledWith(expect.objectContaining({ pointer: '/0', revision: '1', text: false }))
    expect(screen.queryByText('London')).not.toBeInTheDocument()
    fireEvent.click(address)
    await screen.findByRole('button', { name: 'city "London"' })
    expect(inspectFlowOutput).toHaveBeenLastCalledWith(expect.objectContaining({ pointer: '/0/address', revision: '1' }))
    fireEvent.click(item)
    expect(screen.queryByRole('button', { name: /city/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^address / })).not.toBeInTheDocument()
    expect(cancelFlowOutputQuery).toHaveBeenCalledTimes(2)
  })

  it('pages large containers without mounting all their children', async () => {
    vi.mocked(inspectFlowOutput).mockImplementation(async (input) => treePage('array', [{ key: input.cursor ? '100' : '0', pointer: input.cursor ? '/100' : '/0', kind: 'number', preview: input.cursor ? '100' : '0' }], 10_000, input.cursor ? null : 'next-fields'))
    render(<DisplayOutput source={source} value="preview" format="json" compact />, { wrapper })
    await screen.findByRole('button', { name: '0 0' })
    expect(screen.getAllByRole('treeitem')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByRole('button', { name: '100 100' })
    expect(screen.queryByRole('button', { name: '0 0' })).not.toBeInTheDocument()
    expect(inspectFlowOutput).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'next-fields', text: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    await screen.findByRole('button', { name: '0 0' })
  })

  it('falls back to the complete text page when auto detection finds a non-JSON response', async () => {
    vi.mocked(inspectFlowOutput).mockImplementation(async (input) => { if (!input.text) throw 'invalidJson'; return page('Full plain response') })
    render(<DisplayOutput source={source} value="cut preview" format="auto" compact />, { wrapper })
    await screen.findByText('Full plain response')
    expect(inspectFlowOutput).toHaveBeenLastCalledWith(expect.objectContaining({ text: true }))
    expect(screen.queryByRole('tree')).not.toBeInTheDocument()
  })
})
