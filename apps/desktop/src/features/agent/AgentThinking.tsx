import { useEffect, useState } from 'react'
import alcyIcon from '../../assets/alcy-icon.svg'
import { useLanguage } from '../../shared/i18n/use-language'

const MESSAGES = ['route', 'forest', 'antlers', 'payload', 'trail', 'ruminating'] as const
const MESSAGE_INTERVAL_MS = 4000

/** Decorative copy rotates locally; assistive technology receives a stable thinking status. */
export function AgentThinking() {
  const { t } = useLanguage()
  const [message, setMessage] = useState(0)

  useEffect(() => {
    const interval = window.setInterval(() => setMessage((index) => (index + 1) % MESSAGES.length), MESSAGE_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [])

  return (
    <div className="agent-thinking" role="status" aria-label={t('agent.thinking')}>
      <span
        className="agent-thinking-icon"
        aria-hidden="true"
        style={{ maskImage: `url("${alcyIcon}")`, WebkitMaskImage: `url("${alcyIcon}")` }}
      />
      <span className="agent-thinking-text" aria-hidden="true">{t(`agent.thinking.${MESSAGES[message]}`)}</span>
    </div>
  )
}
