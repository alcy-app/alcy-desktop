import { EXTENSION_SIDEBAR_MODULES } from '../../extensions/registry'
import type { ExtensionId } from '../../extensions/types'

const BUILT_IN_SIDEBAR_MODULE_IDS = ['components', 'environments', 'monitors', 'history', 'git'] as const

export type SidebarModuleId = (typeof BUILT_IN_SIDEBAR_MODULE_IDS)[number] | ExtensionId

/** Módulos que podem aparecer na barra de atividades, inclusive os que uma
 * feature flag pode deixar indisponíveis nesta compilação, seguidos dos
 * módulos das extensões. */
export const SIDEBAR_MODULE_IDS: readonly SidebarModuleId[] = [
  ...BUILT_IN_SIDEBAR_MODULE_IDS,
  ...EXTENSION_SIDEBAR_MODULES.map((module) => module.id),
]

export const SIDEBAR_HIDDEN_MODULES_STORAGE_KEY = 'alcy:sidebar:hidden-modules'

function isSidebarModuleId(value: unknown): value is SidebarModuleId {
  return typeof value === 'string' && (SIDEBAR_MODULE_IDS as readonly string[]).includes(value)
}

/** Lê somente ids conhecidos, para que preferências antigas ou corrompidas
 * não afetem módulos novos nem impeçam a navegação. */
export function loadHiddenSidebarModules(): Set<SidebarModuleId> {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_HIDDEN_MODULES_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter(isSidebarModuleId))
  } catch {
    // localStorage indisponível ou conteúdo inválido: usa todos os módulos.
    return new Set()
  }
}

/** Persiste numa ordem estável para a preferência continuar legível e simples
 * de evoluir quando novos módulos forem adicionados. */
export function persistHiddenSidebarModules(hiddenModules: ReadonlySet<SidebarModuleId>) {
  try {
    const hidden = SIDEBAR_MODULE_IDS.filter((id) => hiddenModules.has(id))
    window.localStorage.setItem(SIDEBAR_HIDDEN_MODULES_STORAGE_KEY, JSON.stringify(hidden))
  } catch {
    // localStorage indisponível: a escolha continua valendo nesta sessão.
  }
}

export const SIDEBAR_MODULE_ORDER_STORAGE_KEY = 'alcy:sidebar:module-order'

/** Ordem completa dos módulos: os ids salvos primeiro (só os conhecidos, sem repetição) e, no fim, os
 * que a preferência não conhece — módulos novos entram no lugar padrão sem desfazer a escolha. */
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
    // localStorage indisponível ou conteúdo inválido: usa a ordem padrão.
    return normalizeSidebarModuleOrder([])
  }
}

export function persistSidebarModuleOrder(order: readonly SidebarModuleId[]) {
  try {
    window.localStorage.setItem(SIDEBAR_MODULE_ORDER_STORAGE_KEY, JSON.stringify(order))
  } catch {
    // localStorage indisponível: a ordem continua valendo nesta sessão.
  }
}

/** Move `draggedId` para antes/depois de `targetId` na ordem completa. */
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
