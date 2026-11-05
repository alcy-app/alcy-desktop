import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import { ToastProvider } from '../../shared/ui/Toast'
import { useCollectionsState } from './use-collections-state'

const listCollections = vi.fn()
const saveCollections = vi.fn()
const exportCollections = vi.fn()
const pickExportFile = vi.fn()

vi.mock('../../bindings/export-collections', () => ({
  exportCollections: (...args: unknown[]) => exportCollections(...args),
}))
vi.mock('../../bindings/pick-export-file', () => ({
  pickExportFile: (...args: unknown[]) => pickExportFile(...args),
}))

vi.mock('../../bindings/list-collections', () => ({
  listCollections: (...args: unknown[]) => listCollections(...args),
}))

vi.mock('../../bindings/save-collections', () => ({
  saveCollections: (...args: unknown[]) => saveCollections(...args),
}))

function wrapper({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <ToastProvider>{children}</ToastProvider>
    </LanguageProvider>
  )
}

/** Wait longer than the autosave debounce. */
const afterSaveDebounce = () => new Promise((resolve) => setTimeout(resolve, 700))

describe('useCollectionsState — leitura que falha', () => {
  beforeEach(() => {
    listCollections.mockReset()
    saveCollections.mockReset().mockResolvedValue({ ok: true })
  })

  it('não salva por cima de um arquivo que não conseguiu ler', async () => {
    listCollections.mockResolvedValue({ ok: false, error: { kind: 'storage', message: 'versão de arquivo não suportada: 2' } })
    const { result } = renderHook(() => useCollectionsState('/workspace', vi.fn()), { wrapper })
    await waitFor(() => expect(result.current.loadError).toBe('versão de arquivo não suportada: 2'))

    act(() => {
      result.current.addCollection('Nova')
    })
    await afterSaveDebounce()

    expect(saveCollections).not.toHaveBeenCalled()
  })

  it('volta a salvar depois de uma nova leitura bem-sucedida', async () => {
    listCollections.mockResolvedValueOnce({ ok: false, error: { kind: 'storage', message: 'arquivo corrompido' } })
    const { result } = renderHook(() => useCollectionsState('/workspace', vi.fn()), { wrapper })
    await waitFor(() => expect(result.current.loadError).not.toBeNull())

    listCollections.mockResolvedValue({ ok: true, value: [] })
    act(() => result.current.reload())
    await waitFor(() => expect(result.current.loadError).toBeNull())
    act(() => {
      result.current.addCollection('Nova')
    })

    await waitFor(() => expect(saveCollections).toHaveBeenCalledTimes(1))
  })
})

describe('useCollectionsState — rótulos', () => {
  beforeEach(() => {
    listCollections.mockReset()
    saveCollections.mockReset().mockResolvedValue({ ok: true })
  })

  it('preserva os rótulos ao salvar e não envia o campo para pastas', async () => {
    listCollections.mockResolvedValue({
      ok: true,
      value: [
        {
          id: 'c1',
          name: 'API',
          folders: [{ id: 'f1', name: 'Pedidos', folders: [], requests: [], authentication: { type: 'inherit' } }],
          requests: [],
          authentication: { type: 'inherit' },
          labels: [{ name: 'Pagamentos', color: 'green' }],
        },
      ],
    })
    const { result } = renderHook(() => useCollectionsState('/workspace', vi.fn()), { wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))

    act(() => result.current.assignLabel(['c1'], { name: 'Legado', color: 'gray' }, true))
    await waitFor(() => expect(saveCollections).toHaveBeenCalledTimes(1))

    const [, body] = saveCollections.mock.calls[0]
    expect(body[0].labels).toEqual([
      { name: 'Pagamentos', color: 'green' },
      { name: 'Legado', color: 'gray' },
    ])
    expect(body[0].folders[0]).not.toHaveProperty('labels')
  })
})

describe('useCollectionsState — folder export', () => {
  it('exports only the selected subtree and deduplicates descendants in batch export', async () => {
    const nested = { id: 'f2', name: 'Nested', folders: [], requests: [], variables: [], authentication: { type: 'inherit' } }
    const folder = {
      id: 'f1', name: 'Orders', folders: [nested], requests: [],
      authentication: { type: 'none' },
      variables: [{ key: 'baseUrl', value: 'https://example.com', enabled: true }],
    }
    listCollections.mockResolvedValue({
      ok: true,
      value: [{ id: 'c1', name: 'API', folders: [folder], requests: [], authentication: { type: 'inherit' } }],
    })
    exportCollections.mockReset().mockResolvedValue({ ok: true })
    pickExportFile.mockReset().mockResolvedValue('/export/orders.alcy.json')
    const { result } = renderHook(() => useCollectionsState('/workspace', vi.fn()), { wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))

    await act(() => result.current.exportCollection('f1'))
    expect(pickExportFile).toHaveBeenCalledWith('Orders')
    expect(exportCollections).toHaveBeenLastCalledWith('/export/orders.alcy.json', [folder])

    await act(() => result.current.exportCollectionsByIds(['f2', 'f1']))
    expect(exportCollections).toHaveBeenLastCalledWith('/export/orders.alcy.json', [folder])
  })
})
