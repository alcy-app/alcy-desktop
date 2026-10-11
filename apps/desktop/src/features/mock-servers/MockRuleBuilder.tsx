import { useId } from 'react'
import type { MockConditionDto, MockConditionGroupDto } from '../../bindings/mock-servers'
import { useLanguage } from '../../shared/i18n/use-language'
import { IconButton } from '../../shared/ui/IconButton'
import { Input } from '../../shared/ui/Input'
import { Select } from '../../shared/ui/Select'
import { PlusIcon, TrashIcon } from '../../shared/ui/icons'
import {
  RULE_OPERATORS, RULE_SOURCES, newConditionGroup, newMatchCondition, operatorNeedsValue, sourceNeedsKey,
  type MockMatchCondition,
} from './mock-rules'

interface MockRuleBuilderProps {
  condition: MockConditionGroupDto | null
  pathParameters: string[]
  onChange: (condition: MockConditionGroupDto) => void
}

/** Editor visual das regras de uma resposta condicional, sem exigir JSON. */
export function MockRuleBuilder({ condition, pathParameters, onChange }: MockRuleBuilderProps) {
  const { t } = useLanguage()
  const datalistId = useId()
  const group = condition ?? newConditionGroup()
  const append = (item: MockConditionDto) => onChange({ ...group, conditions: [...group.conditions, item] })

  return <div className="mock-rule-card">
    {pathParameters.length > 0 && <datalist id={datalistId}>{pathParameters.map((name) => <option key={name} value={name} />)}</datalist>}
    {group.conditions.length === 0
      ? <p className="mock-rule-card__empty">{t('mockServers.rules.empty')}</p>
      : <>
        <div className="mock-rule-line mock-rule-line--heading" aria-hidden="true">
          <span />
          <div className="mock-rule-fields"><span>{t('mockServers.rules.sourceHeading')}</span><span>{t('mockServers.rules.fieldHeading')}</span><span>{t('mockServers.rules.conditionHeading')}</span><span>{t('mockServers.rules.valueHeading')}</span><span /></div>
        </div>
        <RuleList group={group} path="" datalistId={pathParameters.length > 0 ? datalistId : undefined} onChange={onChange} />
      </>}
    <div className="mock-rule-card__footer">
      <button type="button" className="mock-rule-add" onClick={() => append(newMatchCondition())}><PlusIcon size={13} />{t('mockServers.rules.addRule')}</button>
      <button type="button" className="mock-rule-add mock-rule-add--secondary" onClick={() => append({ kind: 'group', group: { ...newConditionGroup(), conditions: [newMatchCondition()] } })}><PlusIcon size={13} />{t('mockServers.rules.addGroup')}</button>
    </div>
  </div>
}

interface RuleListProps {
  group: MockConditionGroupDto
  /** Posição do grupo na árvore (`""` na raiz, `"2"`, `"2.1"`…), usada nos rótulos acessíveis. */
  path: string
  datalistId: string | undefined
  onChange: (group: MockConditionGroupDto) => void
}

function RuleList({ group, path, datalistId, onChange }: RuleListProps) {
  const { t } = useLanguage()
  const childPath = (index: number) => (path ? path + '.' : '') + (index + 1)
  const replace = (index: number, next: MockConditionDto) =>
    onChange({ ...group, conditions: group.conditions.map((item, position) => position === index ? next : item) })
  const remove = (index: number) => onChange({ ...group, conditions: group.conditions.filter((_, position) => position !== index) })
  const connector = group.operator === 'all' ? t('mockServers.rules.and') : t('mockServers.rules.or')

  return <ol className="mock-rule-list" aria-label={path ? t('mockServers.rules.groupRulesAria', { path }) : t('mockServers.rules.rootRulesAria')}>
    {group.conditions.map((item, index) => <li key={index} className="mock-rule-line">
      <span className="mock-rule-line__connector">
        {index === 0 ? t('mockServers.rules.when') : index === 1
          ? <Select aria-label={path ? t('mockServers.rules.groupCombinationAria', { path }) : t('mockServers.rules.rootCombinationAria')} value={group.operator} onChange={(event) => onChange({ ...group, operator: event.target.value as MockConditionGroupDto['operator'] })}>
            <option value="all">{t('mockServers.rules.and')}</option>
            <option value="any">{t('mockServers.rules.or')}</option>
          </Select>
          : connector}
      </span>
      {item.kind === 'group'
        ? <RuleGroup group={item.group} path={childPath(index)} datalistId={datalistId} onChange={(next) => replace(index, { kind: 'group', group: next })} onRemove={() => remove(index)} />
        : <RuleFields rule={item} path={childPath(index)} datalistId={datalistId} onChange={(next) => replace(index, next)} onRemove={() => remove(index)} />}
    </li>)}
  </ol>
}

interface RuleGroupProps {
  group: MockConditionGroupDto
  path: string
  datalistId: string | undefined
  onChange: (group: MockConditionGroupDto) => void
  onRemove: () => void
}

function RuleGroup({ group, path, datalistId, onChange, onRemove }: RuleGroupProps) {
  const { t } = useLanguage()
  return <div className="mock-rule-group" role="group" aria-label={t('mockServers.rules.groupAria', { path })}>
    <div className="mock-rule-group__heading">
      <span>{t('mockServers.rules.group')}</span>
      <IconButton icon={<TrashIcon size={13} />} variant="danger" label={t('mockServers.rules.removeGroupAria', { path })} onClick={onRemove} />
    </div>
    {group.conditions.length > 0
      ? <RuleList group={group} path={path} datalistId={datalistId} onChange={onChange} />
      : <p className="mock-rule-card__empty">{t('mockServers.rules.emptyGroup')}</p>}
    <button type="button" className="mock-rule-add" aria-label={t('mockServers.rules.addRuleToGroupAria', { path })} onClick={() => onChange({ ...group, conditions: [...group.conditions, newMatchCondition()] })}><PlusIcon size={13} />{t('mockServers.rules.addRule')}</button>
  </div>
}

interface RuleFieldsProps {
  rule: MockMatchCondition
  path: string
  datalistId: string | undefined
  onChange: (rule: MockMatchCondition) => void
  onRemove: () => void
}

function RuleFields({ rule, path, datalistId, onChange, onRemove }: RuleFieldsProps) {
  const { t } = useLanguage()
  const source = RULE_SOURCES.find((item) => item.value === rule.source) ?? RULE_SOURCES[0]
  const keyPlaceholder = source.keyPlaceholder === null ? '' : 'key' in source.keyPlaceholder ? t(source.keyPlaceholder.key) : source.keyPlaceholder.text
  return <div className="mock-rule-fields">
    <Select aria-label={t('mockServers.rules.sourceAria', { path })} value={rule.source} onChange={(event) => {
      const next = event.target.value as MockMatchCondition['source']
      onChange({ ...rule, source: next, key: sourceNeedsKey(next) ? rule.key : '' })
    }}>{RULE_SOURCES.map((item) => <option key={item.value} value={item.value}>{t(item.label)}</option>)}</Select>
    {sourceNeedsKey(rule.source)
      ? <Input aria-label={t('mockServers.rules.keyAria', { path })} mono placeholder={keyPlaceholder} value={rule.key}
        list={rule.source === 'pathParameter' ? datalistId : undefined} onChange={(event) => onChange({ ...rule, key: event.target.value })} />
      : <span className="mock-rule-fields__none">—</span>}
    <Select aria-label={t('mockServers.rules.operatorAria', { path })} value={rule.operator} onChange={(event) => {
      const next = event.target.value as MockMatchCondition['operator']
      onChange({ ...rule, operator: next, value: operatorNeedsValue(next) ? rule.value : '' })
    }}>{RULE_OPERATORS.map((item) => <option key={item.value} value={item.value}>{t(item.label)}</option>)}</Select>
    {operatorNeedsValue(rule.operator)
      ? <Input aria-label={t('mockServers.rules.valueAria', { path })} mono placeholder={t('mockServers.rules.valuePlaceholder')} value={rule.value} onChange={(event) => onChange({ ...rule, value: event.target.value })} />
      : <span className="mock-rule-fields__none">—</span>}
    <IconButton className="mock-rule-fields__remove" icon={<TrashIcon size={13} />} variant="danger" label={t('mockServers.rules.removeRuleAria', { path })} onClick={onRemove} />
  </div>
}
