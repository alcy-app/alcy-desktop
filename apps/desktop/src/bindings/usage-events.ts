import { invoke } from '@tauri-apps/api/core'
import { invokeResult, type CommandResult } from './invoke-result'

export type ShortcutChange = 'assigned' | 'removed' | 'reset' | 'resetAll'

/**
 * Usage events only the interface sees (spec 0142). Every text field is a
 * code identifier (letters, digits and `_ . : -`), never text typed by the
 * person: Rust drops events with anything else.
 */
export type UsageEventInput =
  | { name: 'shortcut_changed'; action?: string; change: ShortcutChange }
  | { name: 'environment_switched' }
  | { name: 'settings_changed'; category: string; key?: string }
  | { name: 'sidebar_module_opened'; module: string }

/** Whether this build collects usage events and whether the person lets it. */
export interface UsageEventsStatus {
  /** An extension collects usage events in this build. */
  available: boolean
  /** The person's choice in Settings > Telemetry (on by default). */
  enabled: boolean
}

export interface UsageEventsError {
  kind: 'storage'
  message: string
}

/** One recorded event, exactly as handed to the extension. */
export interface RecordedUsageEvent {
  schema: number
  eventId: string
  occurredOn: string
  appVersion: string
  platform: string
  name: string
  props: Record<string, unknown>
}

const UNAVAILABLE: UsageEventsStatus = { available: false, enabled: false }

/** Starts the usage event hub. `utcOffsetMinutes` (minutes to add to UTC)
 * lets events carry the local date; no time of day leaves the app. Outside
 * Tauri the answer is "not available". */
export async function activateUsageEvents(utcOffsetMinutes: number): Promise<UsageEventsStatus> {
  try {
    return await invoke<UsageEventsStatus>('activate_usage_events', { utcOffsetMinutes })
  } catch {
    return UNAVAILABLE
  }
}

export async function getUsageEventsStatus(): Promise<UsageEventsStatus> {
  try {
    return await invoke<UsageEventsStatus>('get_usage_events_status')
  } catch {
    return UNAVAILABLE
  }
}

/** Saves and applies the person's choice; turning it off drops what was
 * recorded and not sent yet. */
export function setUsageEventsEnabled(enabled: boolean): Promise<CommandResult<UsageEventsStatus, UsageEventsError>> {
  return invokeResult('set_usage_events_enabled', { enabled })
}

/** Events recorded in this run, oldest first. */
export async function listRecentUsageEvents(): Promise<RecordedUsageEvent[]> {
  try {
    return await invoke<RecordedUsageEvent[]>('list_recent_usage_events')
  } catch {
    return []
  }
}

/** Records one interface event. Never throws: usage events are best-effort. */
export async function recordUsageEvent(event: UsageEventInput): Promise<void> {
  try {
    await invoke('record_usage_event', { event })
  } catch {
    // Usage events must never affect the interface.
  }
}
