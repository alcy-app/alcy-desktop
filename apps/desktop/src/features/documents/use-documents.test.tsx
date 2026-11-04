import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import { documentCall, pickDocumentImage, readDocument, saveDocumentContent, type DocumentationRecord } from '../../bindings/documentation'
import type { WorkbenchAgentHost } from '../agent/agent-host'
import { forgetRememberedSessions } from '../agent/agent-session-memory'
import { useDocuments, type DocumentActions, type OpenDocument } from './use-documents'

vi.mock('../../bindings/documentation', () => ({ documentCall: vi.fn(), readDocument: vi.fn(), saveDocumentContent: vi.fn(), cancelDocumentJob: vi.fn(), pickDocumentExport: vi.fn(), pickDocumentImage: vi.fn(), uploadDocumentImage: vi.fn() }))
const doc: DocumentationRecord = { version: 1, id: 'one', title: 'Investigation', revision: 1, createdAtMs: 1, updatedAtMs: 1, sources: [], assets: [], markdown: '# Original\n' }
function wrapper({ children }: { children: ReactNode }) { return <LanguageProvider>{children}</LanguageProvider> }
const host = { environments: () => [], collections: () => [], tabs: () => [] } as unknown as WorkbenchAgentHost
function editor(content: ReactNode) { return (content as ReactElement<{ document: OpenDocument; actions: DocumentActions }>).props }
beforeEach(() => {
  vi.resetAllMocks(); forgetRememberedSessions()
  vi.mocked(documentCall).mockResolvedValue({ documents: [doc], nextOffset: null })
  vi.mocked(readDocument).mockResolvedValue({ ...doc })
})

describe('workspace documents', () => {
  it('does not import an image when the operation was cancelled while choosing a file', async () => {
    const { result } = renderHook(() => useDocuments('/workspace'), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(() => result.current.open('one'))
    let choose!: (path: string) => void
    vi.mocked(pickDocumentImage).mockImplementation(() => new Promise((resolve) => { choose = resolve }))
    let importing!: Promise<void>
    act(() => { importing = editor(result.current.tabs[0].content).actions.importImage('one', 1, 'Evidence') })
    act(() => result.current.cancelJob())
    await act(async () => { choose('/chosen/evidence.png'); await importing })
    expect(documentCall).not.toHaveBeenCalledWith('/workspace', 'importImage', expect.anything())
  })
  it('protects unsaved user edits from agent writes and discards by reloading without saving', async () => {
    const { result } = renderHook(() => useDocuments('/workspace'), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(() => result.current.open('one'))
    act(() => editor(result.current.tabs[0].content).actions.edit('one', { markdown: '# Manual\n' }))
    let outcome
    await act(async () => { outcome = await result.current.agent.call('update_document', { documentId: 'one', expectedRevision: 1, append: 'Agent text' }, host) })
    expect(outcome).toMatchObject({ isError: true })
    expect(documentCall).not.toHaveBeenCalledWith('/workspace', 'update', expect.anything())
    await act(() => editor(result.current.tabs[0].content).actions.discard('one'))
    expect(editor(result.current.tabs[0].content).document.markdown).toBe(doc.markdown)
    expect(result.current.tabs[0].dirty).toBe(false)
    expect(saveDocumentContent).not.toHaveBeenCalled()
  })

  it('uses the canonical saved text and preserves edits made while saving', async () => {
    const { result } = renderHook(() => useDocuments('/workspace'), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(() => result.current.open('one'))
    act(() => editor(result.current.tabs[0].content).actions.edit('one', { markdown: 'draft' }))
    let finish!: (doc: DocumentationRecord) => void
    vi.mocked(saveDocumentContent).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const canonical = { ...doc, revision: 2, markdown: 'redacted draft' }
    vi.mocked(readDocument).mockResolvedValue(canonical)
    let saving!: Promise<void>
    act(() => { saving = editor(result.current.tabs[0].content).actions.save('one') })
    act(() => editor(result.current.tabs[0].content).actions.edit('one', { markdown: 'later edits' }))
    await act(async () => { finish(canonical); await saving })
    expect(editor(result.current.tabs[0].content).document.markdown).toBe('later edits')
    expect(editor(result.current.tabs[0].content).document.saved.markdown).toBe('redacted draft')
    expect(result.current.tabs[0].dirty).toBe(true)
  })

  it('returns complete source pages without generic tool-string truncation', async () => {
    const { result } = renderHook(() => useDocuments('/workspace'), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    const text = 'x'.repeat(4096)
    vi.mocked(documentCall).mockResolvedValue({ page: { text, nextOffset: 4096, totalBytes: 8192 }, fromSnapshot: false })
    const outcome = await result.current.agent.call('read_document_source', { documentId: 'one', sourceKind: 'chat', sourceId: 'selected' }, host)
    expect(outcome.isError).toBe(false)
    expect(JSON.parse(outcome.content).page.text).toBe(text)
    expect(JSON.parse(outcome.content).page.nextOffset).toBe(4096)
  })
})
