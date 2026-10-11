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
  'openSettings',
  'acceptSuggestion',
  'toggleSuggestions',
  'openBlockPalette',
] as const
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number]

export const MAX_BINDINGS_PER_ACTION = 2
export const SHORTCUTS_STORAGE_KEY = 'alcy:shortcuts'
const SHORTCUTS_STORAGE_VERSION = 1

/** Ações disparadas por um ponto do canvas de flows — as únicas que aceitam
 * botões do mouse, e que o `FlowCanvas` despacha (não o workbench). */
const CANVAS_ACTIONS: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>(['openBlockPalette'])

export function isCanvasAction(action: ShortcutAction): boolean {
  return CANVAS_ACTIONS.has(action)
}

/** Ações dos editores de código (autocompletar), que os próprios editores
 * despacham — as únicas que aceitam Tab sem modificador. */
const EDITOR_ACTIONS: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>(['acceptSuggestion', 'toggleSuggestions'])

export function isEditorAction(action: ShortcutAction): boolean {
  return EDITOR_ACTIONS.has(action)
}

/** Ações sobre o item focado da sidebar (linha da árvore de collections ou
 * flow), que a própria linha despacha — as únicas que aceitam Delete sem
 * modificador. */
const ITEM_ACTIONS: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>(['renameItem', 'duplicateItem', 'deleteItem'])

export function isItemAction(action: ShortcutAction): boolean {
  return ITEM_ACTIONS.has(action)
}

/** Ações que o workbench não despacha: o componente onde elas acontecem as
 * trata (o canvas de flows; o item focado da sidebar; o editor focado, no
 * caso do autocompletar; a barra de abas, que confirma o descarte ao fechar). */
const LOCAL_ACTIONS: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>([
  ...CANVAS_ACTIONS,
  ...EDITOR_ACTIONS,
  ...ITEM_ACTIONS,
  'closeTab',
])

export function isLocalAction(action: ShortcutAction): boolean {
  return LOCAL_ACTIONS.has(action)
}

/** Botões do mouse como "tecla" principal de uma combinação (spec 0088). */
export const MOUSE_KEYS = ['MouseLeft', 'MouseMiddle', 'MouseRight'] as const
export type MouseKey = (typeof MOUSE_KEYS)[number]

export function isMouseKey(key: string): key is MouseKey {
  return (MOUSE_KEYS as readonly string[]).includes(key)
}

/** Uma combinação de teclas, ou de modificadores com um botão do mouse
 * (`MOUSE_KEYS`). `ctrl` vale tanto para Ctrl quanto para Cmd/Meta. */
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

/** Os padrões seguem as teclas mais comuns entre clientes de API. */
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
  openSettings: [{ ...CTRL, key: ',' }],
  acceptSuggestion: [{ ...NO_MODIFIERS, key: 'Tab' }],
  toggleSuggestions: [{ ...CTRL, key: 'Space' }],
  openBlockPalette: [{ ...NO_MODIFIERS, key: 'MouseRight' }],
}

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'AltGraph', 'Shift', 'Meta', 'OS', 'Super', 'Hyper', 'Fn', 'CapsLock'])
const MODIFIER_NAMES = new Set(['Ctrl', 'Alt', 'Shift'])
/** Sem Ctrl/Alt só estas teclas viram atalho: as demais são digitação ou navegação de foco. */
const PLAIN_KEY = /^(Enter|F([1-9]|1[0-2]))$/
/** Nos editores o Tab já é da edição (indenta), então também pode virar atalho. */
const PLAIN_EDITOR_KEY = /^(Enter|Tab|F([1-9]|1[0-2]))$/
/** No item focado da sidebar não há texto sendo digitado: Delete também pode. */
const PLAIN_ITEM_KEY = /^(Enter|Delete|F([1-9]|1[0-2]))$/

function plainKeyPattern(action: ShortcutAction): RegExp {
  if (isEditorAction(action)) return PLAIN_EDITOR_KEY
  if (isItemAction(action)) return PLAIN_ITEM_KEY
  return PLAIN_KEY
}
/** Edição de texto: o GTK engole Ctrl+Z/Ctrl+Y no Linux e os demais pertencem aos campos. */
const RESERVED_COMBOS = new Set(['Escape', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X'])

function normalizeKey(key: string): string {
  if (key === ' ') return 'Space'
  return key.length === 1 ? key.toUpperCase() : key
}

/** As teclas da combinação na ordem canônica: modificadores e, por último, a tecla principal. */
export function comboParts(combo: KeyCombo): string[] {
  return [combo.ctrl && 'Ctrl', combo.alt && 'Alt', combo.shift && 'Shift', combo.key].filter(
    (part): part is string => Boolean(part),
  )
}

export function formatCombo(combo: KeyCombo): string {
  return comboParts(combo).join('+')
}

/** Lê uma combinação no formato de `formatCombo`, em qualquer ordem de modificadores. */
export function parseCombo(text: string): KeyCombo | null {
  const plusKey = text === '+' || text.endsWith('++')
  const parts = (plusKey ? text.slice(0, -1) : text).split('+')
  const key = plusKey ? '+' : parts.pop()
  if (plusKey) parts.pop()
  if (!key || MODIFIER_NAMES.has(key) || MODIFIER_KEYS.has(key)) return null
  if (new Set(parts).size !== parts.length || parts.some((part) => !MODIFIER_NAMES.has(part))) return null
  return { ctrl: parts.includes('Ctrl'), alt: parts.includes('Alt'), shift: parts.includes('Shift'), key: normalizeKey(key) }
}

/** A combinação de um `keydown`, ou `null` enquanto só um modificador está pressionado. */
export function comboFromEvent(event: KeyEventLike): KeyCombo | null {
  if (MODIFIER_KEYS.has(event.key) || event.key === 'Dead' || event.key === 'Unidentified') return null
  return { ctrl: event.ctrlKey || event.metaKey, alt: event.altKey, shift: event.shiftKey, key: normalizeKey(event.key) }
}

const MOUSE_BUTTON_KEYS: Record<number, MouseKey> = { 0: 'MouseLeft', 1: 'MouseMiddle', 2: 'MouseRight' }

/** A combinação de um clique, ou `null` para botões além dos três principais. */
export function comboFromMouseEvent(event: MouseEventLike): KeyCombo | null {
  const key = MOUSE_BUTTON_KEYS[event.button]
  if (!key) return null
  return { ctrl: event.ctrlKey || event.metaKey, alt: event.altKey, shift: event.shiftKey, key }
}

export function sameCombo(a: KeyCombo, b: KeyCombo): boolean {
  return a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.key === b.key
}

/** Valida `combo` para `action`. Um botão do mouse vale sem modificador,
 * mas só numa ação do canvas; Tab sem modificador, só numa ação do editor;
 * Delete sem modificador, só numa ação do item focado. */
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

/** `combo` (de teclado ou de clique) é um dos atalhos de `action`. */
/** Teclas que um editor de código tratou só para cedê-las ao atalho global
 * (o CodeMirror chama `preventDefault` em toda tecla que um keymap trata). */
const yieldedEvents = new WeakSet<Event>()

/** Marca o evento como cedido pelo editor a um atalho global. */
export function yieldShortcutToWorkbench(event: Event): void {
  yieldedEvents.add(event)
}

/** Outro handler já consumiu a tecla — a menos que um editor a tenha cedido. */
export function isShortcutEventConsumed(event: Event): boolean {
  return event.defaultPrevented && !yieldedEvents.has(event)
}

export function isShortcutFor(bindings: ShortcutBindings, action: ShortcutAction, combo: KeyCombo | null): boolean {
  return combo !== null && bindings[action].some((bound) => sameCombo(bound, combo))
}

/** A outra ação que já usa `combo`, se houver. */
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

/** Grava `combo` no `slot` da ação, tirando-o de qualquer outra ação que o use. */
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

/** Volta a ação ao padrão, tirando as combinações padrão de quem as tiver pego. */
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

/** Atalhos salvos por cima dos padrões. JSON inválido ou versão desconhecida
 * valem os padrões; uma lista inválida vale o padrão só daquela ação. Uma
 * combinação salva vence o padrão de outra ação (p.ex. um padrão criado
 * depois que o usuário já usava aquela tecla). */
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

/** Grava só as ações diferentes do padrão; tudo no padrão apaga a chave. */
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
    // Sem armazenamento os atalhos valem só para esta sessão.
  }
}
