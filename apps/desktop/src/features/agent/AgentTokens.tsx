import { useLanguage } from '../../shared/i18n/use-language'

interface TokenCount {
  input: number
  output: number
}

function useTokenText() {
  const { t, language } = useLanguage()
  const compact = new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 })
  const exact = new Intl.NumberFormat(language)
  return {
    t,
    amount: (tokens: TokenCount) => t('agent.tokens.amount', { input: compact.format(tokens.input), output: compact.format(tokens.output) }),
    detail: (tokens: TokenCount) => t('agent.tokens.detail', { input: exact.format(tokens.input), output: exact.format(tokens.output) }),
  }
}

/** What one answer cost, under it: every model call of the turn (input up, output down). */
export function TurnTokens({ tokens }: { tokens: TokenCount }) {
  const { amount, detail } = useTokenText()
  return (
    <p className="agent-turn-tokens" title={detail(tokens)}>
      {amount(tokens)}
    </p>
  )
}

/** What the whole chat used, above the composer. */
export function SessionTokens({ tokens }: { tokens: TokenCount }) {
  const { t, amount, detail } = useTokenText()
  return (
    <p className="agent-session-tokens" title={detail(tokens)}>
      <span className="agent-session-tokens-label">{t('agent.tokens.session')}</span>
      <span>{amount(tokens)}</span>
    </p>
  )
}
