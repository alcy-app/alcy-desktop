import { describe, expect, it } from 'vitest'
import en from '../../shared/i18n/locales/en'
import ptBR from '../../shared/i18n/locales/pt-BR'
import { NODE_KIND_APPEARANCE } from './node-kind-appearance'

describe('NODE_KIND_APPEARANCE', () => {
  it('cobre os 19 tipos de node', () => {
    expect(Object.keys(NODE_KIND_APPEARANCE).sort()).toEqual(
      [
        'block',
        'break',
        'continue',
        'display',
        'if',
        'inlineRequest',
        'load',
        'log',
        'mockAssertCalls',
        'mockSetResponse',
        'mockStart',
        'mockStop',
        'mockWaitRequest',
        'note',
        'request',
        'setVariables',
        'sleep',
        'start',
        'while',
      ].sort(),
    )
  })

  it('tem título, nome e descrição traduzidos e distintos para cada tipo', () => {
    const descriptions = new Set<string>()
    for (const appearance of Object.values(NODE_KIND_APPEARANCE)) {
      for (const key of [appearance.titleKey, appearance.labelKey, appearance.descriptionKey]) {
        expect(ptBR[key]).toBeTruthy()
        expect(en[key]).toBeTruthy()
      }
      descriptions.add(ptBR[appearance.descriptionKey])
    }
    expect(descriptions.size).toBe(Object.keys(NODE_KIND_APPEARANCE).length)
  })
})
