import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '../../test-utils'
import type { DocumentationRecord } from '../../bindings/documentation'
import { DocumentEditor } from './DocumentEditor'
import type { DocumentActions, OpenDocument } from './use-documents'

vi.mock('../../bindings/documentation', () => ({
  documentCall: vi.fn().mockResolvedValue({ sources: [], nextOffset: null }),
  documentImageUrl: vi.fn(() => new Promise(() => {})),
}))

const asset = 'a'.repeat(64)
const saved: DocumentationRecord = { version: 1, id: 'doc', title: 'Notes', markdown: '# Original', revision: 1, createdAtMs: 1, updatedAtMs: 1, sources: [], assets: [{ id: asset, caption: 'Login response' }] }
function Harness({ overrides = {} }: { overrides?: Partial<DocumentActions> }) {
  const [doc, setDoc] = useState<OpenDocument>({ saved, title: saved.title, markdown: saved.markdown, dirty: false, active: true })
  const actions: DocumentActions = {
    rootPath: '/test', job: null, cancelExport: vi.fn(), describeError: String,
    edit: (_, patch) => setDoc((value) => ({ ...value, ...patch, dirty: true })),
    save: vi.fn(), remove: vi.fn(), selectSources: vi.fn(), importImage: vi.fn(), exportFile: vi.fn(), discard: vi.fn(),
    reload: async () => saved, captureImage: async () => saved,
    ...overrides,
  }
  return <DocumentEditor document={doc} actions={actions} />
}
const textarea = () => screen.getByRole('textbox', { name: /Markdown/ }) as HTMLTextAreaElement

describe('document editor', () => {
  it('preserves unsaved text when switching between writing and preview', () => {
    render(<Harness />)
    fireEvent.change(textarea(), { target: { value: '# Updated' } })
    fireEvent.click(screen.getByRole('radio', { name: /^(Preview|Prévia)$/ }))
    expect(screen.queryByRole('textbox', { name: /Markdown/ })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Updated' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /^(Write|Escrever)$/ }))
    expect(textarea()).toHaveValue('# Updated')
  })

  it('blocks exporting while there are unsaved edits', () => {
    render(<Harness />)
    expect(screen.getByText(/^(Saved|Salvo)$/)).toBeInTheDocument()
    fireEvent.change(textarea(), { target: { value: 'draft' } })
    expect(screen.getAllByText(/Unsaved changes|Alterações não salvas/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /^(Export document|Exportar documento)$/ }))
    expect(screen.getByRole('menuitem', { name: /PDF/ })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: /Markdown/ })).toBeDisabled()
  })

  it('formats the selection from the toolbar and with Ctrl+B', () => {
    render(<Harness />)
    const field = textarea()
    field.setSelectionRange(2, 10)
    fireEvent.keyDown(field, { key: 'b', ctrlKey: true })
    expect(field).toHaveValue('# **Original**')
    expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe('Original')
    fireEvent.click(screen.getByRole('button', { name: /^(Bold|Negrito)/ }))
    expect(field).toHaveValue('# Original')
  })

  it('saves with Ctrl+S from the title field', () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(<Harness overrides={{ save }} />)
    const title = screen.getByRole('textbox', { name: /Document title|Título do documento/ })
    fireEvent.change(title, { target: { value: 'Renamed' } })
    fireEvent.keyDown(title, { key: 's', ctrlKey: true })
    expect(save).toHaveBeenCalledWith('doc')
  })

  it('requires a caption to attach images and inserts attached ones at the cursor', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: /^(Images|Imagens)/ }))
    const panel = screen.getByRole('complementary')
    const attach = within(panel).getByRole('button', { name: /Attach image|Anexar imagem/ })
    expect(attach).toBeDisabled()
    fireEvent.change(within(panel).getByRole('textbox', { name: /Image caption|Legenda/ }), { target: { value: 'Response example' } })
    expect(attach).toBeEnabled()
    textarea().setSelectionRange(10, 10)
    fireEvent.click(within(panel).getByRole('button', { name: /Login response/ }))
    await waitFor(() => expect(textarea()).toHaveValue(`# Original\n\n![Login response](assets/${asset}.png)\n`))
  })

  it('confirms before deleting the document', () => {
    const remove = vi.fn().mockResolvedValue(undefined)
    render(<Harness overrides={{ remove }} />)
    fireEvent.click(screen.getByRole('button', { name: /More actions|Mais ações/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete document|Excluir documento/ }))
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^(Delete|Excluir)$/ }))
    expect(remove).toHaveBeenCalledWith('doc', 1)
  })
})
