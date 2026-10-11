import { describe, expect, it } from 'vitest'
import { translate } from '../../shared/i18n/translations'
import type { TranslationKey, TranslationParams } from '../../shared/i18n/translations'
import { RULE_GROUPS, defaultRule, describeRule, hasParameters } from './rule-catalog'

const t = (key: TranslationKey, params?: TranslationParams) => translate('pt-BR', key, params)

describe('describeRule', () => {
  it('descreve faixas conforme os limites informados', () => {
    expect(describeRule({ kind: 'lengthRange', min: 1, max: 10 }, t)).toBe('Entre 1 e 10 caracteres')
    expect(describeRule({ kind: 'lengthRange', min: null, max: 10 }, t)).toBe('Até 10 caracteres')
    expect(describeRule({ kind: 'numberRange', min: 0, max: null }, t)).toBe('Número a partir de 0')
    expect(describeRule({ kind: 'lengthRange', min: null, max: null }, t)).toBe('Tamanho mínimo e máximo (incompleta)')
  })

  it('descreve comparações de texto e o modo sem diferenciar maiúsculas', () => {
    expect(describeRule({ kind: 'contains', value: '@', caseSensitive: true }, t)).toBe('Contém "@"')
    expect(describeRule({ kind: 'equals', value: 'ativo', caseSensitive: false }, t)).toBe(
      'Igual a "ativo", sem diferenciar maiúsculas',
    )
    expect(describeRule({ kind: 'startsWith', value: '', caseSensitive: true }, t)).toBe('Começa com (incompleta)')
  })

  it('usa o nome da regra para regras sem parâmetros', () => {
    expect(describeRule({ kind: 'lettersOnly' }, t)).toBe('Somente letras')
    expect(describeRule({ kind: 'format', format: 'email' }, t)).toBe('Formato e-mail')
    expect(describeRule({ kind: 'oneOf', values: ['A', 'B'] }, t)).toBe('Um de: A, B')
  })
})

describe('catálogo', () => {
  it('oferece cada tipo de regra uma única vez', () => {
    const kinds = RULE_GROUPS.flatMap((group) => group.kinds)
    expect(new Set(kinds).size).toBe(kinds.length)
    expect(kinds).toHaveLength(18)
  })

  it('cria regras novas já válidas e sabe quais têm parâmetros', () => {
    expect(defaultRule('lengthRange')).toEqual({ kind: 'lengthRange', min: 1, max: 10 })
    expect(defaultRule('noWhitespace')).toEqual({ kind: 'noWhitespace' })
    expect(hasParameters('noWhitespace')).toBe(false)
    expect(hasParameters('regex')).toBe(true)
  })
})
