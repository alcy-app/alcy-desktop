import { EXTENSION_SIDEBAR_MODULES } from '../../extensions/registry'
import type { ExtensionId } from '../../extensions/types'

// `agent` only shows while the agent chat is docked on the left (spec 0143).
const BUILT_IN_SIDEBAR_MODULE_IDS = ['components', 'environments', 'monitors', 'history', 'documents', 'git', 'agent'] as const

export type SidebarModuleId = (typeof BUILT_IN_SIDEBAR_MODULE_IDS)[number] | ExtensionId

/** Activity-bar modules, including those unavailable under this build's
 * feature flags, followed by extension modules. */
export const SIDEBAR_MODULE_IDS: readonly SidebarModuleId[] = [
  ...BUILT_IN_SIDEBAR_MODULE_IDS,
  ...EXTENSION_SIDEBAR_MODULES.map((module) => module.id),
]

export const SIDEBAR_HIDDEN_MODULES_STORAGE_KEY = 'alcy:sidebar:hidden-modules'

function isSidebarModuleId(value: unknown): value is SidebarModuleId {
  return typeof value === 'string' && (SIDEBAR_MODULE_IDS as readonly string[]).includes(value)
}

/** Read only known IDs so old or corrupted preferences cannot hide new
 * modules or prevent navigation. */
export function loadHiddenSidebarModules(): Set<SidebarModuleId> {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_HIDDEN_MODULES_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter(isSidebarModuleId))
  } catch {
    // Unavailable storage or invalid content: show all modules.
    return new Set()
  }
}

/** Keep a stable order so preferences remain readable when modules are added. */
export function persistHiddenSidebarModules(hiddenModules: ReadonlySet<SidebarModuleId>) {
  try {
    const hidden = SIDEBAR_MODULE_IDS.filter((id) => hiddenModules.has(id))
    window.localStorage.setItem(SIDEBAR_HIDDEN_MODULES_STORAGE_KEY, JSON.stringify(hidden))
  } catch {
    // Without localStorage, the selection still applies during this session.
  }
}

export const SIDEBAR_MODULE_ORDER_STORAGE_KEY = 'alcy:sidebar:module-order'

/** Saved, known, unique IDs come first; append new modules in their default
 * order without changing the user's existing ordering. */
export function normalizeSidebarModuleOrder(saved: unknown): SidebarModuleId[] {
  const order: SidebarModuleId[] = []
  if (Array.isArray(saved)) {
    for (const id of saved) if (isSidebarModuleId(id) && !order.includes(id)) order.push(id)
  }
  for (const id of SIDEBAR_MODULE_IDS) if (!order.includes(id)) order.push(id)
  return order
}

export function loadSidebarModuleOrder(): SidebarModuleId[] {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_MODULE_ORDER_STORAGE_KEY)
    return normalizeSidebarModuleOrder(raw ? JSON.parse(raw) : [])
  } catch {
    // Unavailable storage or invalid content: use the default order.
    return normalizeSidebarModuleOrder([])
  }
}

export function persistSidebarModuleOrder(order: readonly SidebarModuleId[]) {
  try {
    window.localStorage.setItem(SIDEBAR_MODULE_ORDER_STORAGE_KEY, JSON.stringify(order))
  } catch {
    // Without localStorage, the ordering still applies during this session.
  }
}

/** Move `draggedId` before or after `targetId` in the complete ordering. */
export function moveSidebarModule(
  order: readonly SidebarModuleId[],
  draggedId: SidebarModuleId,
  targetId: SidebarModuleId,
  edge: 'before' | 'after',
): SidebarModuleId[] {
  if (draggedId === targetId || !order.includes(draggedId) || !order.includes(targetId)) return [...order]
  const next = order.filter((id) => id !== draggedId)
  const targetIndex = next.indexOf(targetId)
  next.splice(edge === 'after' ? targetIndex + 1 : targetIndex, 0, draggedId)
  return next
}
