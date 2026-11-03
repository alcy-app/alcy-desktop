import { activateUsageEvents, recordUsageEvent, type UsageEventInput } from '../../bindings/usage-events'
import { FEATURE_FLAGS } from '../feature-flags'

/**
 * Usage events from the interface (spec 0142). Dormant until
 * `startUsageEvents` learns that an extension collects them; in the public
 * build the answer is no and every later call returns without IPC.
 */

/** Events kept while activation is pending; later ones are dropped. */
const MAX_PENDING = 50

type State = 'idle' | 'starting' | 'active' | 'off'

let state: State = 'idle'
let pending: UsageEventInput[] = []

/** Called once at startup. Safe to call again: only the first call counts. */
export async function startUsageEvents(): Promise<void> {
  if (state !== 'idle') return
  if (!FEATURE_FLAGS.usageEvents) {
    state = 'off'
    return
  }
  state = 'starting'
  // `getTimezoneOffset` is UTC minus local time; the hub adds minutes to UTC.
  const active = await activateUsageEvents(-new Date().getTimezoneOffset())
  state = active ? 'active' : 'off'
  const queued = pending
  pending = []
  if (active) queued.forEach((event) => void recordUsageEvent(event))
}

/** Reports one event; fire-and-forget. */
export function trackUsage(event: UsageEventInput): void {
  switch (state) {
    case 'active':
      void recordUsageEvent(event)
      return
    case 'idle':
    case 'starting':
      if (pending.length < MAX_PENDING) pending.push(event)
      return
    case 'off':
      return
  }
}

/** Back to the initial state (tests only). */
export function resetUsageEventsForTests(): void {
  state = 'idle'
  pending = []
}
