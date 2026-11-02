import type { ValueFormat, ValueRuleKind } from '../../bindings/list-value-monitors'
import type { TranslationKey, TranslationParams } from '../../shared/i18n/translations'

type Translate = (key: TranslationKey, params?: TranslationParams) => string

export type RuleKindName = ValueRuleKind['kind']

/** Rule kinds in the "Add rule" menu, grouped by subject. */
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

/** New rule with valid initial parameters, so the monitor can still be saved right after adding it. */
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

/** Initial pattern when the custom date and time format is picked. */
export const DEFAULT_DATE_TIME_PATTERN = 'DD/MM/YYYY HH:mm:ss'

type FormatRule = Extract<ValueRuleKind, { kind: 'format' }>

/** Switches the format of a rule: the custom date and time format brings its pattern, the others drop it. */
export function withFormat(rule: FormatRule, format: ValueFormat): FormatRule {
  if (format === 'customDateTime') return { kind: 'format', format, pattern: rule.pattern ?? DEFAULT_DATE_TIME_PATTERN }
  return { kind: 'format', format }
}

/** Whether the rule has parameters to edit (the others are just a label). */
export function hasParameters(kind: RuleKindName): boolean {
  return !['lettersOnly', 'digitsOnly', 'alphanumeric', 'noWhitespace', 'notEmpty'].includes(kind)
}

/** Short sentence describing the rule, used in the panel and in the response tooltip. */
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
      if (rule.format === 'customDateTime') {
        const pattern = rule.pattern ?? ''
        return pattern.trim() === '' ? incomplete() : t('monitors.describe.customDateTime', { pattern })
      }
      return t('monitors.describe.format', { format: t(`monitors.format.${rule.format}` as TranslationKey) })
    default:
      return ruleName(rule.kind, t)
  }
}
