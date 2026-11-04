import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../shared/ui/Toast'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import type { DocumentationRecord } from '../../bindings/documentation'
import { DocumentEditor } from './DocumentEditor'
import type { DocumentActions, OpenDocument } from './use-documents'

const saved: DocumentationRecord = { version: 1, id: 'doc', title: 'Notes', markdown: '# Original', revision: 1, createdAtMs: 1, updatedAtMs: 1, sources: [], assets: [] }
function Harness() {
  const [doc, setDoc] = useState<OpenDocument>({ saved, title: saved.title, markdown: saved.markdown, dirty: false, active: true })
  const actions: DocumentActions = {
    rootPath: '/test', job: null, cancelExport: vi.fn(), describeError: String,
    edit: (_, patch) => setDoc((value) => ({ ...value, ...patch, dirty: true })),
    save: vi.fn(), remove: vi.fn(), selectSources: vi.fn(), importImage: vi.fn(), exportFile: vi.fn(), discard: vi.fn(),
    reload: async () => saved, captureImage: async () => saved,
  }
  return <LanguageProvider><ToastProvider><DocumentEditor document={doc} actions={actions} /></ToastProvider></LanguageProvider>
}

describe('document editor views', () => {
  it('preserves unsaved text when switching between writing and preview', () => {
    render(<Harness />)
    fireEvent.change(screen.getByRole('textbox', { name: /Markdown/ }), { target: { value: '# Updated' } })
    fireEvent.click(screen.getByRole('button', { name: /^(Preview|Prévia)$/ }))
    expect(screen.queryByRole('textbox', { name: /Markdown/ })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Updated' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^(Write|Escrever)$/ }))
    expect(screen.getByRole('textbox', { name: /Markdown/ })).toHaveValue('# Updated')
    expect(screen.getByRole('button', { name: 'PDF' })).toBeDisabled()
  })
  it('reveals image controls on demand and requires a caption', () => {
    render(<Harness />)
    expect(screen.queryByRole('textbox', { name: /Image caption|Legenda/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Insert image|Inserir imagem/ }))
    expect(screen.getByRole('button', { name: /Attach image|Anexar imagem/ })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: /Image caption|Legenda/ }), { target: { value: 'Response example' } })
    expect(screen.getByRole('button', { name: /Attach image|Anexar imagem/ })).toBeEnabled()
  })
})
