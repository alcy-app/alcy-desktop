import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '../../test-utils'
import type { DocumentationRecord } from '../../bindings/documentation'
import { DocumentsPanel } from './DocumentsPanel'
import type { DocumentsManager, OpenDocument } from './use-documents'

const record = (id: string, title: string, updatedAtMs: number, createdAtMs = updatedAtMs): DocumentationRecord =>
  ({ version: 1, id, title, markdown: '', revision: 1, createdAtMs, updatedAtMs, sources: [], assets: [] })
const docs = [record('a', 'Beta', 3000, 1000), record('b', 'Alpha', 1000, 3000), record('c', 'Gamma', 2000, 2000)]

function manager(overrides: Partial<DocumentsManager> = {}): DocumentsManager {
  return {
    documents: docs, opened: [], tabs: [], agent: {} as DocumentsManager['agent'], loading: false, error: null, job: null,
    create: vi.fn().mockResolvedValue(docs[0]), open: vi.fn().mockResolvedValue(true), rename: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined), exportFile: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined),
    describeError: String, cancelJob: vi.fn(),
    ...overrides,
  }
}
const titles = () => within(screen.getByRole('list')).getAllByText(/^(Alpha|Beta|Gamma)$/).map((node) => node.textContent)

describe('documents panel', () => {
  it('offers a primary action in the empty state that creates and focuses a new document', () => {
    const value = manager({ documents: [] })
    render(<DocumentsPanel manager={value} />)
    expect(screen.getByText(/No documents yet|Nenhum documento/)).toBeInTheDocument()
    const actions = screen.getAllByRole('button', { name: /New document|Novo documento/ })
    fireEvent.click(actions[actions.length - 1])
    expect(value.create).toHaveBeenCalledWith(expect.stringMatching(/Untitled document|Documento sem título/), true)
  })

  it('sorts by last update by default and by title or creation on request', () => {
    render(<DocumentsPanel manager={manager()} />)
    expect(titles()).toEqual(['Beta', 'Gamma', 'Alpha'])
    fireEvent.click(screen.getByRole('button', { name: /Sort and refresh|Ordenar e atualizar/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Title|Título/ }))
    expect(titles()).toEqual(['Alpha', 'Beta', 'Gamma'])
    fireEvent.click(screen.getByRole('button', { name: /Sort and refresh|Ordenar e atualizar/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Recently created|Criados recentemente/ }))
    expect(titles()).toEqual(['Alpha', 'Gamma', 'Beta'])
  })

  it('filters by title and shows a dedicated empty result', () => {
    render(<DocumentsPanel manager={manager()} />)
    const search = screen.getByRole('textbox', { name: /Search documents|Buscar documentos/ })
    fireEvent.change(search, { target: { value: 'gam' } })
    expect(titles()).toEqual(['Gamma'])
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.getByText(/No matching documents|Nenhum documento encontrado/)).toBeInTheDocument()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(titles()).toHaveLength(3)
  })

  it('renames inline with F2, committing on Enter and cancelling on Escape', async () => {
    const value = manager()
    render(<DocumentsPanel manager={value} />)
    fireEvent.keyDown(screen.getByRole('button', { name: /^Alpha/ }), { key: 'F2' })
    const input = screen.getByRole('textbox', { name: /New document name|Novo nome do documento/ })
    fireEvent.change(input, { target: { value: 'Alpha v2' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(value.rename).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('button', { name: /^Alpha/ }), { key: 'F2' })
    const again = screen.getByRole('textbox', { name: /New document name|Novo nome do documento/ })
    fireEvent.change(again, { target: { value: 'Alpha v2' } })
    fireEvent.keyDown(again, { key: 'Enter' })
    await waitFor(() => expect(value.rename).toHaveBeenCalledWith('b', 'Alpha v2'))
  })

  it('asks for confirmation before deleting from the row menu', async () => {
    const value = manager()
    render(<DocumentsPanel manager={value} />)
    fireEvent.click(screen.getByRole('button', { name: /(Actions for|Ações de) Gamma/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^(Delete|Excluir)/ }))
    expect(value.remove).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^(Delete|Excluir)$/ }))
    await waitFor(() => expect(value.remove).toHaveBeenCalledWith('c', 1))
  })

  it('highlights the active document and marks unsaved drafts', () => {
    const opened: OpenDocument[] = [{ saved: docs[0], title: 'Beta draft', markdown: 'x', dirty: true, active: true }]
    render(<DocumentsPanel manager={manager({ opened })} />)
    const active = screen.getByRole('button', { name: /^Beta draft/ })
    expect(active).toHaveAttribute('aria-current', 'page')
    expect(within(active).getByRole('img', { name: /Unsaved changes|Alterações não salvas/ })).toBeInTheDocument()
  })
})
