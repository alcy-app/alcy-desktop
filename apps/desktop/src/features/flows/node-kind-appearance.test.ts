import { describe, expect, it } from 'vitest'
import en from '../../shared/i18n/locales/en'
import ptBR from '../../shared/i18n/locales/pt-BR'
import { NODE_KIND_APPEARANCE } from './node-kind-appearance'

describe('NODE_KIND_APPEARANCE', () => {
  it('covers all 20 node types', () => {
    expect(Object.keys(NODE_KIND_APPEARANCE).sort()).toEqual(
      [
        'block',
        'break',
        'continue',
        'display',
        'humanAction',
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

  it('has translated titles, names and distinct descriptions for each type', () => {
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
