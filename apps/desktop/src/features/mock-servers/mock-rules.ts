import type { MockConditionDto, MockConditionGroupDto } from '../../bindings/mock-servers'
import type { TranslationKey } from '../../shared/i18n/translations'

export type MockMatchCondition = Extract<MockConditionDto, { kind: 'match' }>
export type MockRuleSource = MockMatchCondition['source']
export type MockRuleOperator = MockMatchCondition['operator']

/** `keyPlaceholder` é um exemplo literal ou, quando depende do idioma, uma chave de tradução. */
export const RULE_SOURCES: Array<{ value: MockRuleSource; label: TranslationKey; keyPlaceholder: { text: string } | { key: TranslationKey } | null }> = [
  { value: 'query', label: 'mockServers.rules.source.query', keyPlaceholder: { text: 'page' } },
  { value: 'header', label: 'mockServers.rules.source.header', keyPlaceholder: { text: 'authorization' } },
  { value: 'pathParameter', label: 'mockServers.rules.source.pathParameter', keyPlaceholder: { text: 'id' } },
  { value: 'jsonPointer', label: 'mockServers.rules.source.jsonPointer', keyPlaceholder: { key: 'mockServers.rules.jsonPointerPlaceholder' } },
  { value: 'bodyText', label: 'mockServers.rules.source.bodyText', keyPlaceholder: null },
]

export const RULE_OPERATORS: Array<{ value: MockRuleOperator; label: TranslationKey; needsValue: boolean }> = [
  { value: 'equals', label: 'mockServers.rules.operator.equals', needsValue: true },
  { value: 'notEquals', label: 'mockServers.rules.operator.notEquals', needsValue: true },
  { value: 'contains', label: 'mockServers.rules.operator.contains', needsValue: true },
  { value: 'exists', label: 'mockServers.rules.operator.exists', needsValue: false },
  { value: 'notExists', label: 'mockServers.rules.operator.notExists', needsValue: false },
]

export const sourceNeedsKey = (source: MockRuleSource) => source !== 'bodyText'
export const operatorNeedsValue = (operator: MockRuleOperator) =>
  RULE_OPERATORS.find((item) => item.value === operator)?.needsValue ?? true

export function newMatchCondition(source: MockRuleSource = 'query'): MockMatchCondition {
  return { kind: 'match', source, key: '', operator: 'equals', value: '' }
}

export function newConditionGroup(): MockConditionGroupDto {
  return { operator: 'all', conditions: [] }
}

/** Nomes dos parâmetros `:nome` de um caminho de rota, na ordem em que aparecem. */
export function routePathParameters(path: string): string[] {
  return path.split('/').filter((part) => part.startsWith(':') && part.length > 1).map((part) => part.slice(1))
}

const SOURCES = new Set<string>(RULE_SOURCES.map((item) => item.value))
const OPERATORS = new Set<string>(RULE_OPERATORS.map((item) => item.value))
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** Valida a estrutura completa das regras editadas como JSON; retorna `null` quando algo não confere. */
export function parseConditionGroup(value: unknown): MockConditionGroupDto | null {
  if (!isRecord(value) || (value.operator !== 'all' && value.operator !== 'any') || !Array.isArray(value.conditions)) return null
  const conditions: MockConditionDto[] = []
  for (const item of value.conditions) {
    if (!isRecord(item)) return null
    if (item.kind === 'group') {
      const group = parseConditionGroup(item.group)
      if (!group) return null
      conditions.push({ kind: 'group', group })
    } else if (item.kind === 'match') {
      const { source, key, operator, value: expected } = item
      if (typeof source !== 'string' || !SOURCES.has(source) || typeof operator !== 'string' || !OPERATORS.has(operator)) return null
      if (typeof key !== 'string' || typeof expected !== 'string') return null
      conditions.push({ kind: 'match', source: source as MockRuleSource, key, operator: operator as MockRuleOperator, value: expected })
    } else return null
  }
  return { operator: value.operator, conditions }
}
