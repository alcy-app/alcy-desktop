import { activateUsageEvents, recordUsageEvent, type UsageEventInput, type UsageEventsStatus } from '../../bindings/usage-events'
import { FEATURE_FLAGS } from '../feature-flags'

/**
 * Usage events from the interface (spec 0142). Dormant until
 * `startUsageEvents` learns that an extension collects them and the person
 * lets it; in the public build the answer is no and every later call
 * returns without IPC.
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
  const status = await activateUsageEvents(-new Date().getTimezoneOffset())
  const queued = pending
  pending = []
  if (applyUsageEventsStatus(status)) queued.forEach((event) => void recordUsageEvent(event))
}

/** Follows the person's choice made in Settings > Telemetry. Returns
 * whether interface events are reported. */
export function applyUsageEventsStatus(status: UsageEventsStatus): boolean {
  if (!FEATURE_FLAGS.usageEvents) return false
  const active = status.available && status.enabled
  state = active ? 'active' : 'off'
  if (!active) pending = []
  return active
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
