import { afterEach, describe, expect, it, vi } from 'vitest'

const flags = vi.hoisted(() => ({ updates: false, valueMonitors: true, documents: true }))
vi.mock('../../shared/feature-flags', () => ({ FEATURE_FLAGS: flags }))

async function loadLabels() {
  vi.resetModules()
  return import('./file-labels')
}

describe('rótulos do versionamento e a flag do monitor de valores', () => {
  afterEach(() => {
    flags.valueMonitors = true
  })

  it('ligada, nomeia o arquivo e o tipo de item', async () => {
    const { FILE_LABELS, itemKindLabelKey } = await loadLabels()
    expect(FILE_LABELS['alcy-value-monitors.json']).toBe('Monitores')
    expect(itemKindLabelKey('monitor')).toBe('vc.item.monitor')
  })

  it('desligada, o arquivo aparece só pelo nome e o item com rótulo genérico', async () => {
    flags.valueMonitors = false
    const { FILE_LABELS, itemKindLabelKey } = await loadLabels()
    expect(FILE_LABELS['alcy-value-monitors.json']).toBeUndefined()
    expect(itemKindLabelKey('monitor')).toBe('vc.item.generic')
    expect(itemKindLabelKey('flow')).toBe('vc.item.flow')
  })

  it('names files inside versioned folders by their folder', async () => {
    const { fileLabel } = await loadLabels()
    expect(fileLabel('alcy-mock-servers.json')).toBe('Mock servers')
    expect(fileLabel('alcy-documents/doc-1/document.json')).toBe('Documentos')
    expect(fileLabel('alcy-flow-assets/flow-1/users.csv')).toBe('Arquivos de flows')
    expect(fileLabel('alcy-history.json')).toBe('alcy-history.json')
  })
})
