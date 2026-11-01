import { useSyncExternalStore } from 'react'
import { FEATURE_FLAGS } from '../../shared/feature-flags'

const CHAT_ENABLED_KEY = 'alcy:agent:chat-enabled'
const CONTEXT_OPTIONS_DISABLED_KEY = 'alcy:agent:context-options-disabled'
const CHANGED_EVENT = 'alcy:agent-preferences-changed'
const sessionValues = new Map<string, boolean>()

function readPreference(key: string, defaultValue: boolean): boolean {
  const sessionValue = sessionValues.get(key)
  if (sessionValue !== undefined) return sessionValue
  try {
    const value = window.localStorage.getItem(key)
    return value === 'true' ? true : value === 'false' ? false : defaultValue
  } catch {
    return defaultValue
  }
}

function writePreference(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, String(value))
    sessionValues.delete(key)
  } catch {
    // Without storage, the preference still applies for this session.
    sessionValues.set(key, value)
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

/** Machine-local presentation preferences, shared by Settings, the panel and item menus. */
export function useAgentPreferences() {
  const chatEnabled = useSyncExternalStore(subscribe, readChatEnabled)
  const contextOptionsDisabled = useSyncExternalStore(subscribe, readContextOptionsDisabled)
  return {
    chatEnabled,
    contextOptionsDisabled,
    contextOptionsEnabled: FEATURE_FLAGS.agent && chatEnabled && !contextOptionsDisabled,
    setChatEnabled,
    setContextOptionsDisabled,
  }
}
