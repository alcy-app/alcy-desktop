import { useLanguage } from '../../shared/i18n/use-language'
import type { ConditionState } from './flows.types'
import { CONDITION_OPERATOR_SYMBOL } from './simple-node-types'

/** Condição de um `if`/`while` no cartão: operando, pílula do operador e
 * operando — cada lado com reticências próprias, para o operador nunca sumir. */
export function ConditionView({ condition }: { condition: ConditionState }) {
  const { t } = useLanguage()

  if (!condition.left && !condition.right) {
    return <span className="flow-node-placeholder">{t('flows.canvas.conditionEmpty')}</span>
  }
  return (
    <div className="flow-node-condition">
      <code className="flow-node-condition-operand" title={condition.left}>
        {condition.left || '—'}
      </code>
      <span className="flow-node-condition-operator">{CONDITION_OPERATOR_SYMBOL[condition.operator]}</span>
      <code className="flow-node-condition-operand" title={condition.right}>
        {condition.right || '—'}
      </code>
    </div>
  )
}
