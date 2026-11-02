import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '../../../test-utils'
import type { LoadTestImportAnalysisDto } from '../../../bindings/load-test-import'
import { ImportLoadTestModal } from './ImportLoadTestModal'

const preview: LoadTestImportAnalysisDto = {
  format: 'k6',
  analysisHash: 'analysis',
  flow: { id: 'flow', name: 'Catalog load', executionKind: 'load', nodes: [], edges: [], createdAtMs: 0, updatedAtMs: 0 },
  blocks: 11,
  destinations: ['http://127.0.0.1:8787/products?limit=10', 'http://127.0.0.1:8787/products/sku-001'],
  assets: ['source', 'data/products.csv'],
  requiredVariables: ['BASE_URL'],
}

describe('ImportLoadTestModal', () => {
  it('reviews the source, targets, copied files and required variables before importing', () => {
    const onConfirm = vi.fn()
    render(<ImportLoadTestModal sourcePath="C:\\examples\\catalog.k6.js" preview={preview} onConfirm={onConfirm} onClose={vi.fn()} />)

    expect(screen.getByText('catalog.k6.js')).toBeInTheDocument()
    expect(screen.getByText('Catalog load')).toBeInTheDocument()
    const destinations = screen.getByRole('list', { name: 'Destinos' })
    expect(within(destinations).getAllByRole('listitem')).toHaveLength(2)
    expect(destinations).toHaveTextContent(preview.destinations[1])
    const assets = screen.getByRole('list', { name: 'Arquivos' })
    expect(assets).toHaveTextContent('Script de origem')
    expect(assets).toHaveTextContent('data/products.csv')
    expect(screen.getByRole('list', { name: 'Variáveis a configurar' })).toHaveTextContent('BASE_URL')
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Importar flow' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('cancels without importing and handles previews without targets, assets or variables', async () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(<ImportLoadTestModal sourcePath="/examples/test.jmx" preview={{ ...preview, format: 'jmeter', destinations: [], assets: [], requiredVariables: [] }} onConfirm={onConfirm} onClose={onClose} />)

    expect(screen.getByText('JMeter')).toBeInTheDocument()
    expect(screen.getByText('Nenhum destino HTTP')).toBeInTheDocument()
    expect(screen.queryByText('Variáveis a configurar')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('bounds rendered destination rows while keeping the full list scrollable', () => {
    const destinations = Array.from({ length: 1000 }, (_, index) => `http://127.0.0.1:8787/products/${index}`)
    render(<ImportLoadTestModal sourcePath="/examples/catalog.k6.js" preview={{ ...preview, destinations }} onConfirm={vi.fn()} onClose={vi.fn()} />)

    const list = screen.getByRole('list', { name: 'Destinos' })
    expect(within(list).getAllByRole('listitem').length).toBeLessThan(30)
    fireEvent.scroll(list, { target: { scrollTop: 38 * 995 } })
    expect(within(list).getByText(destinations[999])).toBeInTheDocument()
  })
})
