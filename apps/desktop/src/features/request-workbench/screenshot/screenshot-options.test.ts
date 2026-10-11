import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SCREENSHOT_OPTIONS, loadScreenshotOptions, persistScreenshotOptions } from './screenshot-options'

describe('screenshot options', () => {
  beforeEach(() => window.localStorage.clear())

  it('começa com os padrões', () => {
    expect(loadScreenshotOptions()).toEqual(DEFAULT_SCREENSHOT_OPTIONS)
  })

  it('persiste e recarrega as escolhas', () => {
    const options = {
      ...DEFAULT_SCREENSHOT_OPTIONS,
      layout: 'sideBySide' as const,
      theme: 'dark' as const,
      fields: { ...DEFAULT_SCREENSHOT_OPTIONS.fields, requestHeaders: true },
    }
    persistScreenshotOptions(options)
    expect(loadScreenshotOptions()).toEqual(options)
  })

  it('troca só os valores inválidos pelo padrão', () => {
    window.localStorage.setItem(
      'alcy:share:screenshot',
      JSON.stringify({ layout: 'diagonal', theme: 'dark', fields: { url: false, status: 'sim' } }),
    )
    const options = loadScreenshotOptions()
    expect(options.layout).toBe('vertical')
    expect(options.theme).toBe('dark')
    expect(options.fields.url).toBe(false)
    expect(options.fields.status).toBe(true)
  })

  it('ignora conteúdo corrompido', () => {
    window.localStorage.setItem('alcy:share:screenshot', '{não é json')
    expect(loadScreenshotOptions()).toEqual(DEFAULT_SCREENSHOT_OPTIONS)
  })
})
