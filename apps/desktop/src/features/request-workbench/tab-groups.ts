import { LABEL_COLORS } from './collection-labels'
import type { LabelColor } from '../../bindings/list-collections'
import type { OpenTabDescriptor } from './use-open-tabs'
import type { DropEdge } from '../../shared/use-pointer-drag'

/** Visual organization only; membership never changes the underlying resource. */
export interface TabGroup {
  id: string
  name: string
  color: LabelColor
  collapsed: boolean
  tabIds: string[]
}

export const TAB_GROUP_NAME_LIMIT = 64

/** Drop malformed groups, stale memberships and duplicate assignments independently. */
export function parseTabGroups(raw: unknown, eligibleIds: ReadonlySet<string>): TabGroup[] {
  if (!Array.isArray(raw)) return []
  const groupIds = new Set<string>()
  const assigned = new Set<string>()
  return raw.flatMap((value: unknown): TabGroup[] => {
    if (typeof value !== 'object' || value === null) return []
    const group = value as Record<string, unknown>
    if (typeof group.id !== 'string' || !group.id || groupIds.has(group.id)
      || typeof group.name !== 'string' || !group.name.trim()
      || !LABEL_COLORS.includes(group.color as LabelColor) || !Array.isArray(group.tabIds)) return []
    groupIds.add(group.id)
    const tabIds = group.tabIds.filter((id: unknown): id is string => {
      if (typeof id !== 'string' || !eligibleIds.has(id) || assigned.has(id)) return false
      assigned.add(id)
      return true
    })
    return tabIds.length ? [{ id: group.id, name: group.name.trim().slice(0, TAB_GROUP_NAME_LIMIT), color: group.color as LabelColor, collapsed: group.collapsed === true, tabIds }] : []
  })
}

export function eligibleGroupIds(tabs: readonly OpenTabDescriptor[]): Set<string> {
  return new Set(tabs.filter((tab) => !tab.fixed && tab.fixable !== false).map((tab) => tab.id))
}

/** Keep each group contiguous at its first member's position; fixed tabs keep their own lane. */
export function arrangeGroupedTabs(tabs: readonly OpenTabDescriptor[], groups: readonly TabGroup[]): OpenTabDescriptor[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]))
  const membership = new Map(groups.flatMap((group) => group.tabIds.map((id) => [id, group] as const)))
  const emitted = new Set<string>()
  return tabs.flatMap((tab) => {
    const group = membership.get(tab.id)
    if (!group) return [tab]
    if (emitted.has(group.id)) return []
    emitted.add(group.id)
    return group.tabIds.flatMap((id) => { const member = byId.get(id); return member ? [member] : [] })
  })
}

export function moveTabsToGroup(groups: readonly TabGroup[], ids: readonly string[], groupId: string | null, targetId?: string, edge: DropEdge = 'after'): TabGroup[] {
  const moved = new Set(ids)
  if (targetId && moved.has(targetId)) return [...groups]
  return groups.map((group) => {
    const tabIds = group.tabIds.filter((id) => !moved.has(id))
    if (group.id === groupId) {
      const targetIndex = targetId ? tabIds.indexOf(targetId) : -1
      const at = targetIndex < 0 ? tabIds.length : targetIndex + (edge === 'before' ? 0 : 1)
      tabIds.splice(at, 0, ...ids)
    }
    return { ...group, tabIds }
  }).filter((group) => group.tabIds.length > 0)
}
