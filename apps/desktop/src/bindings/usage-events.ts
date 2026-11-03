import { invoke } from '@tauri-apps/api/core'

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

/** Starts recording usage events. `utcOffsetMinutes` (minutes to add to UTC)
 * lets events carry the local date; no time of day leaves the app. `false`
 * when no extension collects them (the public build) or outside Tauri: the
 * interface then stops reporting. */
export async function activateUsageEvents(utcOffsetMinutes: number): Promise<boolean> {
  try {
    return await invoke<boolean>('activate_usage_events', { utcOffsetMinutes })
  } catch {
    return false
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
