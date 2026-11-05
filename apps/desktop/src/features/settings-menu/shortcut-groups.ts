import type { ShortcutAction } from '../../shared/shortcuts/shortcuts'

export type ShortcutGroup = 'requests' | 'tabs' | 'collections' | 'items' | 'interface' | 'editors' | 'flows'

/** Actions grouped by where they act, in table order. */
export const SHORTCUT_GROUPS: ReadonlyArray<{ id: ShortcutGroup; actions: readonly ShortcutAction[] }> = [
  { id: 'requests', actions: ['sendRequest', 'saveRequest', 'newRequest'] },
  { id: 'tabs', actions: ['closeTab', 'groupTabs', 'nextTab', 'previousTab'] },
  { id: 'collections', actions: ['newCollection', 'importCollections', 'searchCollections'] },
  { id: 'items', actions: ['renameItem', 'duplicateItem', 'deleteItem'] },
  { id: 'interface', actions: ['toggleSidebar', 'toggleAgentPanel', 'openSettings'] },
  { id: 'editors', actions: ['showSuggestions', 'acceptSuggestion', 'toggleComment'] },
  { id: 'flows', actions: ['openBlockPalette'] },
]
