import { describe, expect, it } from 'vitest'
import { DEFAULT_SHORTCUTS, findShortcutAction, isLocalAction, readStoredShortcuts, SHORTCUTS_STORAGE_KEY } from './shortcuts'

describe('group tabs shortcut', () => {
  it('registers Ctrl+G and Cmd+G as a configurable action dispatched by the tab bar', () => {
    expect(findShortcutAction(DEFAULT_SHORTCUTS, new KeyboardEvent('keydown', { key: 'g', ctrlKey: true }))).toBe('groupTabs')
    expect(findShortcutAction(DEFAULT_SHORTCUTS, new KeyboardEvent('keydown', { key: 'g', metaKey: true }))).toBe('groupTabs')
    expect(isLocalAction('groupTabs')).toBe(true)
  })

  it('preserves an existing custom assignment of Ctrl+G instead of stealing it', () => {
    window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify({ version: 1, bindings: { saveRequest: ['Ctrl+G'] } }))
    const bindings = readStoredShortcuts()
    expect(bindings.groupTabs).toEqual([])
    expect(findShortcutAction(bindings, new KeyboardEvent('keydown', { key: 'g', ctrlKey: true }))).toBe('saveRequest')
  })
})
