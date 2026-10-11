import { afterEach, describe, expect, it, vi } from 'vitest'

const flags = vi.hoisted(() => ({ updates: false, valueMonitors: true }))
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
})
