import type { CaseStyle, ValueFormat, ValueRuleKind, ValueType } from '../../bindings/list-value-monitors'
import { useLanguage } from '../../shared/i18n/use-language'
import { Checkbox } from '../../shared/ui/Checkbox'
import { Input } from '../../shared/ui/Input'
import { Select } from '../../shared/ui/Select'
import { TokenInput } from './TokenInput'

const CASE_STYLES: CaseStyle[] = ['upper', 'lower', 'capitalized', 'title']
const VALUE_TYPES: ValueType[] = ['string', 'number', 'boolean', 'null']
const FORMATS: ValueFormat[] = ['email', 'uuid', 'isoDate', 'isoDateTime', 'url']

interface RuleEditorProps {
  rule: ValueRuleKind
  /** Prefixo único para os ids dos campos (associa rótulo e input). */
  idPrefix: string
  onChange: (rule: ValueRuleKind) => void
}

/** Texto do input numérico → número; vazio ou inválido vira `null` ("sem limite"). */
function parseOptionalNumber(text: string, integer: boolean): number | null {
  if (text.trim() === '') return null
  const value = Number(text)
  if (!Number.isFinite(value)) return null
  return integer ? Math.max(0, Math.trunc(value)) : value
}

/** Parâmetros de uma regra, compactos e numa linha sempre que possível. */
export function RuleEditor({ rule, idPrefix, onChange }: RuleEditorProps) {
  const { t } = useLanguage()
  const id = (name: string) => `${idPrefix}-${name}`

  switch (rule.kind) {
    case 'exactLength':
      return (
        <div className="vm-rule-params">
          <label className="vm-param" htmlFor={id('length')}>
            <span>{t('monitors.param.length')}</span>
            <Input
              id={id('length')}
              type="number"
              min={0}
              className="vm-param-number"
              value={rule.length}
              onChange={(event) => onChange({ ...rule, length: parseOptionalNumber(event.target.value, true) ?? 0 })}
            />
          </label>
        </div>
      )
    case 'lengthRange':
    case 'numberRange': {
      const integer = rule.kind === 'lengthRange'
      return (
        <div className="vm-rule-params">
          <label className="vm-param" htmlFor={id('min')}>
            <span>{t('monitors.param.min')}</span>
            <Input
              id={id('min')}
              type="number"
              min={integer ? 0 : undefined}
              className="vm-param-number"
              value={rule.min ?? ''}
              onChange={(event) => onChange({ ...rule, min: parseOptionalNumber(event.target.value, integer) })}
            />
          </label>
          <label className="vm-param" htmlFor={id('max')}>
            <span>{t('monitors.param.max')}</span>
            <Input
              id={id('max')}
              type="number"
              min={integer ? 0 : undefined}
              className="vm-param-number"
              value={rule.max ?? ''}
              onChange={(event) => onChange({ ...rule, max: parseOptionalNumber(event.target.value, integer) })}
            />
          </label>
        </div>
      )
    }
    case 'case':
      return (
        <div className="vm-rule-params">
          <label className="vm-param vm-param--grow" htmlFor={id('style')}>
            <span>{t('monitors.param.style')}</span>
            <Select id={id('style')} value={rule.style} onChange={(event) => onChange({ ...rule, style: event.target.value as CaseStyle })}>
              {CASE_STYLES.map((style) => (
                <option key={style} value={style}>
                  {t(`monitors.case.${style}`)}
                </option>
              ))}
            </Select>
          </label>
        </div>
      )
    case 'equals':
    case 'contains':
    case 'notContains':
    case 'startsWith':
    case 'endsWith':
      return (
        <div className="vm-rule-params vm-rule-params--stacked">
          <label className="vm-param vm-param--grow" htmlFor={id('value')}>
            <span>{t('monitors.param.value')}</span>
            <Input id={id('value')} value={rule.value} onChange={(event) => onChange({ ...rule, value: event.target.value })} />
          </label>
          <label className="vm-param-check" htmlFor={id('case-sensitive')}>
            <Checkbox
              id={id('case-sensitive')}
              checked={rule.caseSensitive}
              onChange={(event) => onChange({ ...rule, caseSensitive: event.target.checked })}
            />
            <span>{t('monitors.param.caseSensitive')}</span>
          </label>
        </div>
      )
    case 'oneOf':
      return (
        <div className="vm-rule-params vm-rule-params--stacked">
          <span className="vm-param-label">{t('monitors.param.values')}</span>
          <TokenInput
            tokens={rule.values}
            placeholder={t('monitors.param.valuesPlaceholder')}
            inputAriaLabel={t('monitors.param.values')}
            removeAriaLabel={(value) => t('monitors.removeValueAria', { value })}
            onAdd={(value) => {
              if (!rule.values.includes(value)) onChange({ ...rule, values: [...rule.values, value] })
            }}
            onRemove={(value) => onChange({ ...rule, values: rule.values.filter((current) => current !== value) })}
          />
        </div>
      )
    case 'regex':
      return (
        <div className="vm-rule-params vm-rule-params--stacked">
          <label className="vm-param vm-param--grow" htmlFor={id('pattern')}>
            <span>{t('monitors.param.pattern')}</span>
            <Input
              id={id('pattern')}
              mono
              spellCheck={false}
              value={rule.pattern}
              onChange={(event) => onChange({ ...rule, pattern: event.target.value })}
            />
          </label>
          <p className="vm-param-hint">{t('monitors.param.patternHint')}</p>
        </div>
      )
    case 'type':
      return (
        <div className="vm-rule-params">
          <label className="vm-param vm-param--grow" htmlFor={id('type')}>
            <span>{t('monitors.param.valueType')}</span>
            <Select
              id={id('type')}
              value={rule.valueType}
              onChange={(event) => onChange({ ...rule, valueType: event.target.value as ValueType })}
            >
              {VALUE_TYPES.map((valueType) => (
                <option key={valueType} value={valueType}>
                  {t(`monitors.type.${valueType}`)}
                </option>
              ))}
            </Select>
          </label>
        </div>
      )
    case 'format':
      return (
        <div className="vm-rule-params">
          <label className="vm-param vm-param--grow" htmlFor={id('format')}>
            <span>{t('monitors.param.format')}</span>
            <Select id={id('format')} value={rule.format} onChange={(event) => onChange({ ...rule, format: event.target.value as ValueFormat })}>
              {FORMATS.map((format) => (
                <option key={format} value={format}>
                  {t(`monitors.format.${format}`)}
                </option>
              ))}
            </Select>
          </label>
        </div>
      )
    default:
      return null
  }
}
