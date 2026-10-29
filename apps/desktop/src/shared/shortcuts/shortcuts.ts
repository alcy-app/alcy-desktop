export const SHORTCUT_ACTIONS = [
  'sendRequest',
  'saveRequest',
  'newRequest',
  'closeTab',
  'nextTab',
  'previousTab',
  'newCollection',
  'importCollections',
  'searchCollections',
  'renameItem',
  'duplicateItem',
  'deleteItem',
  'toggleSidebar',
  'toggleAgentPanel',
  'openSettings',
  'showSuggestions',
  'acceptSuggestion',
  'openBlockPalette',
] as const
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number]

export const MAX_BINDINGS_PER_ACTION = 2
export const SHORTCUTS_STORAGE_KEY = 'alcy:shortcuts'
const SHORTCUTS_STORAGE_VERSION = 1

/** Actions fired at a point of the flows canvas — the only ones that accept
 * mouse buttons, dispatched by `FlowCanvas` (not the workbench). */
const CANVAS_ACTIONS: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>(['openBlockPalette'])

export function isCanvasAction(action: ShortcutAction): boolean {
  return CANVAS_ACTIONS.has(action)
}

/** Code editor actions (autocomplete), dispatched by the editors themselves
 * — the only ones that accept Tab without a modifier. */
const EDITOR_ACTIONS: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>([
  'showSuggestions',
  'acceptSuggestion',
])

export function isEditorAction(action: ShortcutAction): boolean {
  return EDITOR_ACTIONS.has(action)
}

/** Actions on the focused sidebar item (collection tree or flow row),
 * dispatched by the row itself — the only ones that accept Delete without a
 * modifier. */
const ITEM_ACTIONS: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>(['renameItem', 'duplicateItem', 'deleteItem'])

export function isItemAction(action: ShortcutAction): boolean {
  return ITEM_ACTIONS.has(action)
}

/** Actions the workbench does not dispatch: the component where they happen
 * handles them (the flows canvas; the focused sidebar item; the focused
 * editor, for autocomplete; the tab bar, which confirms discarding on close). */
const LOCAL_ACTIONS: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>([
  ...CANVAS_ACTIONS,
  ...EDITOR_ACTIONS,
  ...ITEM_ACTIONS,
  'closeTab',
])

export function isLocalAction(action: ShortcutAction): boolean {
  return LOCAL_ACTIONS.has(action)
}

/** Mouse buttons as the main "key" of a combination (spec 0088). */
export const MOUSE_KEYS = ['MouseLeft', 'MouseMiddle', 'MouseRight'] as const
export type MouseKey = (typeof MOUSE_KEYS)[number]

export function isMouseKey(key: string): key is MouseKey {
  return (MOUSE_KEYS as readonly string[]).includes(key)
}

/** A key combination, or modifiers with a mouse button (`MOUSE_KEYS`).
 * `ctrl` stands for both Ctrl and Cmd/Meta. */
export interface KeyCombo {
  ctrl: boolean
  alt: boolean
  shift: boolean
  key: string
}

export type ShortcutBindings = Record<ShortcutAction, KeyCombo[]>

export type ComboValidation = 'ok' | 'needsModifier' | 'reserved' | 'mouseNotAllowed'

type KeyEventLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>
type MouseEventLike = Pick<MouseEvent, 'button' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>

const NO_MODIFIERS = { ctrl: false, alt: false, shift: false }

const CTRL = { ...NO_MODIFIERS, ctrl: true }
const CTRL_SHIFT = { ...CTRL, shift: true }

/** The defaults follow the most common keys among API clients. */
export const DEFAULT_SHORTCUTS: ShortcutBindings = {
  sendRequest: [{ ...NO_MODIFIERS, key: 'Enter' }, { ...CTRL, key: 'Enter' }],
  saveRequest: [{ ...CTRL, key: 'S' }],
  newRequest: [{ ...CTRL, key: 'N' }, { ...CTRL, key: 'T' }],
  closeTab: [{ ...CTRL, key: 'W' }],
  nextTab: [{ ...CTRL, key: 'Tab' }],
  previousTab: [{ ...CTRL_SHIFT, key: 'Tab' }],
  newCollection: [{ ...CTRL_SHIFT, key: 'N' }],
  importCollections: [{ ...CTRL, key: 'O' }],
  searchCollections: [{ ...CTRL_SHIFT, key: 'F' }],
  renameItem: [{ ...NO_MODIFIERS, key: 'F2' }, { ...CTRL, key: 'E' }],
  duplicateItem: [{ ...CTRL, key: 'D' }],
  deleteItem: [{ ...NO_MODIFIERS, key: 'Delete' }],
  toggleSidebar: [{ ...CTRL, key: '\\' }],
  toggleAgentPanel: [{ ...CTRL_SHIFT, key: 'A' }],
  openSettings: [{ ...CTRL, key: ',' }],
  showSuggestions: [{ ...CTRL, key: 'Space' }],
  acceptSuggestion: [{ ...NO_MODIFIERS, key: 'Tab' }],
  openBlockPalette: [{ ...NO_MODIFIERS, key: 'MouseRight' }],
}

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'AltGraph', 'Shift', 'Meta', 'OS', 'Super', 'Hyper', 'Fn', 'CapsLock'])
const MODIFIER_NAMES = new Set(['Ctrl', 'Alt', 'Shift'])
/** Without Ctrl/Alt only these keys become shortcuts: the rest are typing or focus navigation. */
const PLAIN_KEY = /^(Enter|F([1-9]|1[0-2]))$/
/** In the editors Tab already belongs to editing (indents), so it can be a shortcut too. */
const PLAIN_EDITOR_KEY = /^(Enter|Tab|F([1-9]|1[0-2]))$/
/** On the focused sidebar item no text is being typed: Delete is allowed too. */
const PLAIN_ITEM_KEY = /^(Enter|Delete|F([1-9]|1[0-2]))$/

function plainKeyPattern(action: ShortcutAction): RegExp {
  if (isEditorAction(action)) return PLAIN_EDITOR_KEY
  if (isItemAction(action)) return PLAIN_ITEM_KEY
  return PLAIN_KEY
}
/** Text editing: GTK swallows Ctrl+Z/Ctrl+Y on Linux and the others belong to the fields. */
const RESERVED_COMBOS = new Set(['Escape', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X'])

function normalizeKey(key: string): string {
  if (key === ' ') return 'Space'
  return key.length === 1 ? key.toUpperCase() : key
}

/** The keys of the combination in canonical order: modifiers, then the main key. */
export function comboParts(combo: KeyCombo): string[] {
  return [combo.ctrl && 'Ctrl', combo.alt && 'Alt', combo.shift && 'Shift', combo.key].filter(
    (part): part is string => Boolean(part),
  )
}

export function formatCombo(combo: KeyCombo): string {
  return comboParts(combo).join('+')
}

/** Reads a combination in the `formatCombo` format, with modifiers in any order. */
export function parseCombo(text: string): KeyCombo | null {
  const plusKey = text === '+' || text.endsWith('++')
  const parts = (plusKey ? text.slice(0, -1) : text).split('+')
  const key = plusKey ? '+' : parts.pop()
  if (plusKey) parts.pop()
  if (!key || MODIFIER_NAMES.has(key) || MODIFIER_KEYS.has(key)) return null
  if (new Set(parts).size !== parts.length || parts.some((part) => !MODIFIER_NAMES.has(part))) return null
  return { ctrl: parts.includes('Ctrl'), alt: parts.includes('Alt'), shift: parts.includes('Shift'), key: normalizeKey(key) }
}

/** The combination of a `keydown`, or `null` while only a modifier is pressed. */
export function comboFromEvent(event: KeyEventLike): KeyCombo | null {
  if (MODIFIER_KEYS.has(event.key) || event.key === 'Dead' || event.key === 'Unidentified') return null
  return { ctrl: event.ctrlKey || event.metaKey, alt: event.altKey, shift: event.shiftKey, key: normalizeKey(event.key) }
}

const MOUSE_BUTTON_KEYS: Record<number, MouseKey> = { 0: 'MouseLeft', 1: 'MouseMiddle', 2: 'MouseRight' }

/** The combination of a click, or `null` for buttons beyond the main three. */
export function comboFromMouseEvent(event: MouseEventLike): KeyCombo | null {
  const key = MOUSE_BUTTON_KEYS[event.button]
  if (!key) return null
  return { ctrl: event.ctrlKey || event.metaKey, alt: event.altKey, shift: event.shiftKey, key }
}

export function sameCombo(a: KeyCombo, b: KeyCombo): boolean {
  return a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.key === b.key
}

/** Validates `combo` for `action`. A mouse button is allowed without a
 * modifier, but only for a canvas action; Tab without a modifier, only for an
 * editor action; Delete without a modifier, only for a focused-item action. */
export function validateCombo(combo: KeyCombo, action: ShortcutAction): ComboValidation {
  if (isMouseKey(combo.key)) return isCanvasAction(action) ? 'ok' : 'mouseNotAllowed'
  if (RESERVED_COMBOS.has(formatCombo(combo))) return 'reserved'
  if (!combo.ctrl && !combo.alt && !plainKeyPattern(action).test(combo.key)) return 'needsModifier'
  return 'ok'
}

export function findShortcutAction(bindings: ShortcutBindings, event: KeyEventLike): ShortcutAction | null {
  const combo = comboFromEvent(event)
  if (!combo) return null
  return SHORTCUT_ACTIONS.find((action) => bindings[action].some((bound) => sameCombo(bound, combo))) ?? null
}

/** Keys a code editor handled only to yield them to the global shortcut
 * (CodeMirror calls `preventDefault` on every key a keymap handles). */
const yieldedEvents = new WeakSet<Event>()

/** Marks the event as yielded by the editor to a global shortcut. */
export function yieldShortcutToWorkbench(event: Event): void {
  yieldedEvents.add(event)
}

/** Another handler already consumed the key — unless an editor yielded it. */
export function isShortcutEventConsumed(event: Event): boolean {
  return event.defaultPrevented && !yieldedEvents.has(event)
}

/** `combo` (from the keyboard or a click) is one of the shortcuts of `action`. */
export function isShortcutFor(bindings: ShortcutBindings, action: ShortcutAction, combo: KeyCombo | null): boolean {
  return combo !== null && bindings[action].some((bound) => sameCombo(bound, combo))
}

/** The other action already using `combo`, if any. */
export function findConflict(bindings: ShortcutBindings, combo: KeyCombo, exceptAction: ShortcutAction): ShortcutAction | null {
  return (
    SHORTCUT_ACTIONS.find(
      (action) => action !== exceptAction && bindings[action].some((bound) => sameCombo(bound, combo)),
    ) ?? null
  )
}

export function isDefaultBinding(bindings: ShortcutBindings, action: ShortcutAction): boolean {
  const current = bindings[action]
  const defaults = DEFAULT_SHORTCUTS[action]
  return current.length === defaults.length && current.every((combo, index) => sameCombo(combo, defaults[index]))
}

function withoutCombos(bindings: ShortcutBindings, combos: KeyCombo[], exceptAction: ShortcutAction): ShortcutBindings {
  const next = { ...bindings }
  for (const action of SHORTCUT_ACTIONS) {
    if (action === exceptAction) continue
    const kept = next[action].filter((bound) => !combos.some((combo) => sameCombo(bound, combo)))
    if (kept.length !== next[action].length) next[action] = kept
  }
  return next
}

/** Stores `combo` in the action's `slot`, removing it from any other action using it. */
export function assignShortcut(
  bindings: ShortcutBindings,
  action: ShortcutAction,
  slot: number,
  combo: KeyCombo,
): ShortcutBindings {
  const current = bindings[action]
  if (current.some((bound) => sameCombo(bound, combo))) return bindings
  const list = [...current]
  if (slot < list.length) list[slot] = combo
  else if (list.length < MAX_BINDINGS_PER_ACTION) list.push(combo)
  else return bindings
  return { ...withoutCombos(bindings, [combo], action), [action]: list }
}

export function removeShortcut(bindings: ShortcutBindings, action: ShortcutAction, slot: number): ShortcutBindings {
  return { ...bindings, [action]: bindings[action].filter((_, index) => index !== slot) }
}

/** Resets the action to its default, taking the default combinations from whoever took them. */
export function resetShortcut(bindings: ShortcutBindings, action: ShortcutAction): ShortcutBindings {
  return { ...withoutCombos(bindings, DEFAULT_SHORTCUTS[action], action), [action]: DEFAULT_SHORTCUTS[action] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseStoredList(value: unknown, action: ShortcutAction): KeyCombo[] | null {
  if (!Array.isArray(value) || value.length > MAX_BINDINGS_PER_ACTION) return null
  const combos: KeyCombo[] = []
  for (const item of value) {
    const combo = typeof item === 'string' ? parseCombo(item) : null
    if (!combo || validateCombo(combo, action) !== 'ok' || combos.some((other) => sameCombo(other, combo))) return null
    combos.push(combo)
  }
  return combos
}

/** Stored shortcuts over the defaults. Invalid JSON or an unknown version
 * yields the defaults; an invalid list yields the default of that action only.
 * A stored combination beats another action's default (e.g. a default added
 * after the user already used that key). */
export function readStoredShortcuts(): ShortcutBindings {
  let parsed: unknown
  try {
    const raw = window.localStorage.getItem(SHORTCUTS_STORAGE_KEY)
    if (raw === null) return DEFAULT_SHORTCUTS
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_SHORTCUTS
  }
  if (!isRecord(parsed) || parsed.version !== SHORTCUTS_STORAGE_VERSION || !isRecord(parsed.bindings)) {
    return DEFAULT_SHORTCUTS
  }
  const stored = parsed.bindings
  const bindings = { ...DEFAULT_SHORTCUTS }
  const custom: ShortcutAction[] = []
  for (const action of SHORTCUT_ACTIONS) {
    if (!(action in stored)) continue
    const combos = parseStoredList(stored[action], action)
    if (combos) {
      bindings[action] = combos
      custom.push(action)
    }
  }
  for (const action of SHORTCUT_ACTIONS) {
    if (custom.includes(action)) continue
    const taken = custom.flatMap((other) => bindings[other])
    bindings[action] = bindings[action].filter((combo) => !taken.some((other) => sameCombo(combo, other)))
  }
  return bindings
}

/** Stores only the actions that differ from the default; all defaults removes the key. */
export function writeStoredShortcuts(bindings: ShortcutBindings): void {
  const changed = SHORTCUT_ACTIONS.filter((action) => !isDefaultBinding(bindings, action))
  try {
    if (changed.length === 0) {
      window.localStorage.removeItem(SHORTCUTS_STORAGE_KEY)
      return
    }
    const stored = Object.fromEntries(changed.map((action) => [action, bindings[action].map(formatCombo)]))
    window.localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({ version: SHORTCUTS_STORAGE_VERSION, bindings: stored }),
    )
  } catch {
    // Without storage the shortcuts last only for this session.
  }
}
