import { useSyncExternalStore } from 'react'
import { FEATURE_FLAGS } from '../../shared/feature-flags'

const CHAT_ENABLED_KEY = 'alcy:agent:chat-enabled'
const CONTEXT_OPTIONS_DISABLED_KEY = 'alcy:agent:context-options-disabled'
const DOCK_KEY = 'alcy:agent:dock'
const CHANGED_EVENT = 'alcy:agent-preferences-changed'
const sessionValues = new Map<string, string>()

/** Where the agent panel sits around the main area. */
export type AgentDock = 'right' | 'left' | 'bottom'
export const AGENT_DOCKS: readonly AgentDock[] = ['right', 'left', 'bottom']

function readStored(key: string): string | null {
  const sessionValue = sessionValues.get(key)
  if (sessionValue !== undefined) return sessionValue
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function readPreference(key: string, defaultValue: boolean): boolean {
  const value = readStored(key)
  return value === 'true' ? true : value === 'false' ? false : defaultValue
}

function writePreference(key: string, value: boolean | string) {
  try {
    window.localStorage.setItem(key, String(value))
    sessionValues.delete(key)
  } catch {
    // Without storage, the preference still applies for this session.
    sessionValues.set(key, String(value))
  }
  window.dispatchEvent(new Event(CHANGED_EVENT))
}

function subscribe(listener: () => void) {
  window.addEventListener(CHANGED_EVENT, listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(CHANGED_EVENT, listener)
    window.removeEventListener('storage', listener)
  }
}

const readChatEnabled = () => readPreference(CHAT_ENABLED_KEY, true)
const readContextOptionsDisabled = () => readPreference(CONTEXT_OPTIONS_DISABLED_KEY, false)
const setChatEnabled = (value: boolean) => writePreference(CHAT_ENABLED_KEY, value)
const setContextOptionsDisabled = (value: boolean) => writePreference(CONTEXT_OPTIONS_DISABLED_KEY, value)
const readDock = (): AgentDock => {
  const value = readStored(DOCK_KEY)
  return AGENT_DOCKS.find((dock) => dock === value) ?? 'right'
}
const setDock = (value: AgentDock) => writePreference(DOCK_KEY, value)

/** Machine-local presentation preferences, shared by Settings, the panel and item menus. */
export function useAgentPreferences() {
  const chatEnabled = useSyncExternalStore(subscribe, readChatEnabled)
  const contextOptionsDisabled = useSyncExternalStore(subscribe, readContextOptionsDisabled)
  const dock = useSyncExternalStore(subscribe, readDock)
  return {
    chatEnabled,
    contextOptionsDisabled,
    contextOptionsEnabled: FEATURE_FLAGS.agent && chatEnabled && !contextOptionsDisabled,
    setChatEnabled,
    setContextOptionsDisabled,
    dock,
    setDock,
  }
}
