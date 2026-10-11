import { useEffect, useState } from 'react'
import { formatElapsed } from '../response-summary'

const TICK_MS = 100

/** Contador ao vivo do envio em andamento. Isolado num componente próprio para
 * que o tique só re-renderize este `span`, não o painel de resposta inteiro. */
export function ElapsedTimer({ startedAt, label }: { startedAt: number; label: string }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(id)
  }, [])

  return (
    <span className="rw-response-metric" role="timer" aria-label={label}>
      {formatElapsed(now - startedAt)}
    </span>
  )
}
