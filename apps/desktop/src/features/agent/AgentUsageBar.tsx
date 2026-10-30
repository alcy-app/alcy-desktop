import type { AgentProviderDto, AgentTokenTotalsDto, AgentUsageDto } from '../../bindings/agent-settings'
import { useLanguage } from '../../shared/i18n/use-language'
import { usageLevel } from './agent-usage'

interface AgentUsageBarProps {
  provider: AgentProviderDto
  usage: AgentUsageDto
}

/** Tokens the active provider used today and this week, against the user's limits. Only warns. */
export function AgentUsageBar({ provider, usage }: AgentUsageBarProps) {
  const { t, language } = useLanguage()
  const compact = new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 })
  const exact = new Intl.NumberFormat(language)

  const period = (key: 'today' | 'week', totals: AgentTokenTotalsDto, limit: number | null) => {
    const used = totals.input + totals.output
    const level = usageLevel(used, limit)
    const label = t(`agent.usage.${key}`)
    const amount = limit === null ? compact.format(used) : `${compact.format(used)} / ${compact.format(limit)}`
    return (
      <div
        className="agent-usage-period"
        data-level={level}
        title={t('agent.usage.detail', { input: exact.format(totals.input), output: exact.format(totals.output) })}
      >
        <span className="agent-usage-label">{label}</span>
        <span className="agent-usage-amount">{amount}</span>
        {limit !== null && (
          <span
            className="agent-usage-meter"
            role="meter"
            aria-label={t('agent.usage.meterAria', { period: label })}
            aria-valuemin={0}
            aria-valuemax={limit}
            aria-valuenow={Math.min(used, limit)}
          >
            <span style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} />
          </span>
        )}
      </div>
    )
  }

  const dailyExceeded = usageLevel(usage.today.input + usage.today.output, provider.dailyTokenLimit) === 'exceeded'
  const weeklyExceeded = usageLevel(usage.week.input + usage.week.output, provider.weeklyTokenLimit) === 'exceeded'

  return (
    <div className="agent-usage" aria-label={t('agent.usage.aria', { provider: provider.label })} role="group">
      <span className="agent-usage-title">{t('agent.usage.tokens')}</span>
      {period('today', usage.today, provider.dailyTokenLimit)}
      {period('week', usage.week, provider.weeklyTokenLimit)}
      {(dailyExceeded || weeklyExceeded) && (
        <span className="agent-usage-alert" role="status">
          {t(weeklyExceeded ? 'agent.usage.weeklyExceeded' : 'agent.usage.dailyExceeded')}
        </span>
      )}
    </div>
  )
}
