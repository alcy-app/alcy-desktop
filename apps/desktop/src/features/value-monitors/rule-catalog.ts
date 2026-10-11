import type { ValueRuleKind } from '../../bindings/list-value-monitors'
import type { TranslationKey, TranslationParams } from '../../shared/i18n/translations'

type Translate = (key: TranslationKey, params?: TranslationParams) => string

export type RuleKindName = ValueRuleKind['kind']

/** Tipos de regra no menu "Adicionar regra", agrupados por assunto. */
export const RULE_GROUPS: { label: TranslationKey; kinds: RuleKindName[] }[] = [
  { label: 'monitors.group.length', kinds: ['exactLength', 'lengthRange', 'notEmpty'] },
  { label: 'monitors.group.content', kinds: ['lettersOnly', 'digitsOnly', 'alphanumeric', 'noWhitespace', 'case'] },
  {
    label: 'monitors.group.comparison',
    kinds: ['equals', 'contains', 'notContains', 'startsWith', 'endsWith', 'oneOf', 'regex'],
  },
  { label: 'monitors.group.format', kinds: ['type', 'numberRange', 'format'] },
]

export function ruleName(kind: RuleKindName, t: Translate): string {
  return t(`monitors.rule.${kind}` as TranslationKey)
}

/** Regra nova com parâmetros iniciais válidos — o monitor continua salvável logo depois de adicionar. */
export function defaultRule(kind: RuleKindName): ValueRuleKind {
  switch (kind) {
    case 'exactLength':
      return { kind, length: 10 }
    case 'lengthRange':
      return { kind, min: 1, max: 10 }
    case 'numberRange':
      return { kind, min: 0, max: null }
    case 'case':
      return { kind, style: 'capitalized' }
    case 'equals':
    case 'contains':
    case 'notContains':
    case 'startsWith':
    case 'endsWith':
      return { kind, value: '', caseSensitive: true }
    case 'oneOf':
      return { kind, values: [] }
    case 'regex':
      return { kind, pattern: '' }
    case 'type':
      return { kind, valueType: 'string' }
    case 'format':
      return { kind, format: 'email' }
    default:
      return { kind }
  }
}

/** Se a regra tem parâmetros a editar (as demais são só um rótulo). */
export function hasParameters(kind: RuleKindName): boolean {
  return !['lettersOnly', 'digitsOnly', 'alphanumeric', 'noWhitespace', 'notEmpty'].includes(kind)
}

/** Frase curta que descreve a regra, usada no painel e no tooltip da resposta. */
export function describeRule(rule: ValueRuleKind, t: Translate): string {
  const incomplete = () => t('monitors.describe.incomplete', { rule: ruleName(rule.kind, t) })
  switch (rule.kind) {
    case 'exactLength':
      return t('monitors.describe.exactLength', { length: rule.length })
    case 'lengthRange':
    case 'numberRange': {
      const prefix = rule.kind === 'lengthRange' ? 'length' : 'number'
      if (rule.min !== null && rule.max !== null)
        return t(`monitors.describe.${prefix}Between` as TranslationKey, { min: rule.min, max: rule.max })
      if (rule.min !== null) return t(`monitors.describe.${prefix}Min` as TranslationKey, { min: rule.min })
      if (rule.max !== null) return t(`monitors.describe.${prefix}Max` as TranslationKey, { max: rule.max })
      return incomplete()
    }
    case 'case':
      return t(`monitors.case.${rule.style}` as TranslationKey)
    case 'equals':
    case 'contains':
    case 'notContains':
    case 'startsWith':
    case 'endsWith': {
      if (rule.value === '' && rule.kind !== 'equals') return incomplete()
      const text = t(`monitors.describe.${rule.kind}` as TranslationKey, { value: rule.value })
      return rule.caseSensitive ? text : t('monitors.describe.ignoreCase', { rule: text })
    }
    case 'oneOf':
      return rule.values.length === 0 ? incomplete() : t('monitors.describe.oneOf', { values: rule.values.join(', ') })
    case 'regex':
      return rule.pattern === '' ? incomplete() : t('monitors.describe.regex', { pattern: rule.pattern })
    case 'type':
      return t('monitors.describe.type', { type: t(`monitors.type.${rule.valueType}` as TranslationKey) })
    case 'format':
      return t('monitors.describe.format', { format: t(`monitors.format.${rule.format}` as TranslationKey) })
    default:
      return ruleName(rule.kind, t)
  }
}
