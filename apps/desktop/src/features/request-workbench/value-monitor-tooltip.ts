import type { ValueMonitorDto } from '../../bindings/list-value-monitors'
import type { TranslationKey, TranslationParams } from '../../shared/i18n/translations'
import { describeRule } from '../value-monitors/rule-catalog'
import type { MonitorHighlight } from './use-value-monitor-findings'

type Translate = (key: TranslationKey, params?: TranslationParams) => string

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * Cartão do hover de um valor monitorado: para cada monitor que o avaliou,
 * o nome, o campo e — quando reprovou — as regras que falharam.
 */
export function monitorTooltipContent(highlight: MonitorHighlight, monitors: ValueMonitorDto[], t: Translate): HTMLElement {
  const card = element('div', 'rw-monitor-card')
  for (const result of highlight.results) {
    const monitor = monitors.find((candidate) => candidate.id === result.monitorId)
    const failed = result.failedRuleIds.length > 0

    const header = element('div', 'rw-monitor-card-header')
    const status = element('span', `rw-monitor-card-status rw-monitor-card-status--${failed ? 'failed' : 'passed'}`)
    status.setAttribute('aria-hidden', 'true')
    header.append(
      status,
      element('span', 'rw-monitor-card-name', monitor?.name.trim() || t('common.unnamed')),
      element('span', 'rw-monitor-card-field', result.field),
    )
    card.append(header)

    if (!failed) {
      card.append(element('p', 'rw-monitor-card-verdict', t('monitor.passed')))
      continue
    }
    const list = element('ul', 'rw-monitor-card-rules')
    list.setAttribute('aria-label', t('monitor.failed'))
    for (const ruleId of result.failedRuleIds) {
      const rule = monitor?.rules.find((candidate) => candidate.id === ruleId)
      if (rule) list.append(element('li', '', describeRule(rule, t)))
    }
    card.append(list)
  }
  return card
}
