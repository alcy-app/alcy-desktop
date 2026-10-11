import { useCallback, useState } from 'react'
import type { RecordedEntry, RecordedEntryInput } from './har-redaction'

const MAX_ENTRIES = 500

/** Gravação em memória de chamadas para exportar como HAR. Só acumula
 * enquanto `recording` está ativo; ordem cronológica (mais antiga primeiro),
 * ao contrário do console. */
export function useRecorderState() {
  const [recording, setRecording] = useState(false)
  const [entries, setEntries] = useState<RecordedEntry[]>([])

  const start = useCallback(() => setRecording(true), [])
  const stop = useCallback(() => setRecording(false), [])
  const clear = useCallback(() => setEntries([]), [])

  const remove = useCallback((id: string) => {
    setEntries((current) => current.filter((entry) => entry.id !== id))
  }, [])

  const append = useCallback(
    (entry: RecordedEntryInput) => {
      if (!recording) return
      setEntries((current) => {
        const next = [...current, { ...entry, id: crypto.randomUUID() }]
        return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
      })
    },
    [recording],
  )

  return { recording, entries, start, stop, clear, remove, append }
}
