import type { ShortcutAction } from '../../shared/shortcuts/shortcuts'

export type ShortcutGroup = 'requests' | 'tabs' | 'collections' | 'items' | 'interface' | 'editors' | 'flows'

/** As ações agrupadas por onde agem, na ordem da tabela. */
export const SHORTCUT_GROUPS: ReadonlyArray<{ id: ShortcutGroup; actions: readonly ShortcutAction[] }> = [
  { id: 'requests', actions: ['sendRequest', 'saveRequest', 'newRequest'] },
  { id: 'tabs', actions: ['closeTab', 'nextTab', 'previousTab'] },
  { id: 'collections', actions: ['newCollection', 'importCollections', 'searchCollections'] },
  { id: 'items', actions: ['renameItem', 'duplicateItem', 'deleteItem'] },
  { id: 'interface', actions: ['toggleSidebar', 'openSettings'] },
  { id: 'editors', actions: ['acceptSuggestion', 'toggleSuggestions'] },
  { id: 'flows', actions: ['openBlockPalette'] },
]
