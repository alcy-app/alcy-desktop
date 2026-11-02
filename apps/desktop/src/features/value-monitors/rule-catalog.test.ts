import { describe, expect, it } from 'vitest'
import { translate } from '../../shared/i18n/translations'
import type { TranslationKey, TranslationParams } from '../../shared/i18n/translations'
import { DEFAULT_DATE_TIME_PATTERN, RULE_GROUPS, defaultRule, describeRule, hasParameters, withFormat } from './rule-catalog'

const t = (key: TranslationKey, params?: TranslationParams) => translate('pt-BR', key, params)

describe('describeRule', () => {
  it('describes ranges by the limits given', () => {
    expect(describeRule({ kind: 'lengthRange', min: 1, max: 10 }, t)).toBe('Entre 1 e 10 caracteres')
    expect(describeRule({ kind: 'lengthRange', min: null, max: 10 }, t)).toBe('Até 10 caracteres')
    expect(describeRule({ kind: 'numberRange', min: 0, max: null }, t)).toBe('Número a partir de 0')
    expect(describeRule({ kind: 'lengthRange', min: null, max: null }, t)).toBe('Tamanho mínimo e máximo (incompleta)')
  })

  it('describes text comparisons and the case-insensitive mode', () => {
    expect(describeRule({ kind: 'contains', value: '@', caseSensitive: true }, t)).toBe('Contém "@"')
    expect(describeRule({ kind: 'equals', value: 'ativo', caseSensitive: false }, t)).toBe(
      'Igual a "ativo", sem diferenciar maiúsculas',
    )
    expect(describeRule({ kind: 'startsWith', value: '', caseSensitive: true }, t)).toBe('Começa com (incompleta)')
  })

  it('uses the rule name for rules without parameters', () => {
    expect(describeRule({ kind: 'lettersOnly' }, t)).toBe('Somente letras')
    expect(describeRule({ kind: 'format', format: 'email' }, t)).toBe('Formato e-mail')
    expect(describeRule({ kind: 'oneOf', values: ['A', 'B'] }, t)).toBe('Um de: A, B')
  })

  it('shows the pattern of the custom date and time format', () => {
    expect(describeRule({ kind: 'format', format: 'customDateTime', pattern: 'DD/MM/YYYY' }, t)).toBe(
      'Data e hora no formato DD/MM/YYYY',
    )
    expect(describeRule({ kind: 'format', format: 'customDateTime', pattern: ' ' }, t)).toBe('Formato (incompleta)')
  })
})

describe('withFormat', () => {
  it('brings an initial pattern for the custom date and drops it for other formats', () => {
    const custom = withFormat({ kind: 'format', format: 'email' }, 'customDateTime')
    expect(custom).toEqual({ kind: 'format', format: 'customDateTime', pattern: DEFAULT_DATE_TIME_PATTERN })
    expect(withFormat({ ...custom, pattern: 'YYYY' }, 'customDateTime').pattern).toBe('YYYY')
    expect(withFormat(custom, 'uuid')).toEqual({ kind: 'format', format: 'uuid' })
  })
})

describe('catalog', () => {
  it('offers each rule kind only once', () => {
    const kinds = RULE_GROUPS.flatMap((group) => group.kinds)
    expect(new Set(kinds).size).toBe(kinds.length)
    expect(kinds).toHaveLength(18)
  })

  it('creates valid new rules and knows which have parameters', () => {
    expect(defaultRule('lengthRange')).toEqual({ kind: 'lengthRange', min: 1, max: 10 })
    expect(defaultRule('noWhitespace')).toEqual({ kind: 'noWhitespace' })
    expect(hasParameters('noWhitespace')).toBe(false)
    expect(hasParameters('regex')).toBe(true)
  })
})
