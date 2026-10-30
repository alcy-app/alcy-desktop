import { useCallback, useMemo, useState } from 'react'
import { LABEL_COLORS } from './collection-labels'
import type { OpenTabDescriptor } from './use-open-tabs'
import { eligibleGroupIds, moveTabsToGroup, parseTabGroups, TAB_GROUP_NAME_LIMIT } from './tab-groups'
import type { TabGroup } from './tab-groups'
import type { DropEdge } from '../../shared/use-pointer-drag'

export function useTabGroups(tabs: readonly OpenTabDescriptor[], pinTab: (id: string) => void) {
  const [storedGroups, setGroups] = useState<TabGroup[]>([])
  const eligible = eligibleGroupIds(tabs)
  const membershipKey = JSON.stringify([...eligible])
  const [previousKey, setPreviousKey] = useState(membershipKey)
  // Reconcile during render so closed or fixed tabs cannot retain dormant memberships.
  // Restoration replaces tabs and groups together in the same React batch.
  if (previousKey !== membershipKey) {
    setPreviousKey(membershipKey)
    if (storedGroups.some((group) => group.tabIds.some((id) => !eligible.has(id)))) {
      setGroups(parseTabGroups(storedGroups, eligible))
    }
  }
  const groups = useMemo(() => parseTabGroups(storedGroups, new Set<string>(JSON.parse(membershipKey) as string[])), [storedGroups, membershipKey])

  const createGroup = (ids: readonly string[], name: string): string | null => {
    const tabIds = [...new Set(ids)].filter((id) => eligible.has(id))
    const trimmedName = name.trim().slice(0, TAB_GROUP_NAME_LIMIT)
    if (!tabIds.length || !trimmedName) return null
    tabIds.forEach((tabId) => pinTab(tabId))
    const id = crypto.randomUUID()
    const color = LABEL_COLORS[(storedGroups.length + 6) % LABEL_COLORS.length]
    setGroups((current) => [...moveTabsToGroup(current, tabIds, null), { id, name: trimmedName, color, collapsed: false, tabIds }])
    return id
  }

  const moveTabs = (ids: readonly string[], groupId: string | null, targetId?: string, edge?: DropEdge) => {
    const members = [...new Set(ids)].filter((id) => eligible.has(id))
    if (groupId !== null && !groups.some((group) => group.id === groupId)) return
    if (groupId !== null) members.forEach((tabId) => pinTab(tabId))
    setGroups((current) => moveTabsToGroup(current, members, groupId, targetId, edge))
  }

  const updateGroup = (id: string, patch: Partial<Pick<TabGroup, 'name' | 'color' | 'collapsed'>>) => {
    const name = patch.name?.trim().slice(0, TAB_GROUP_NAME_LIMIT)
    if (patch.name !== undefined && !name) return
    setGroups((current) => {
      const group = current.find((candidate) => candidate.id === id)
      const normalized = { ...patch, ...(name ? { name } : {}) }
      if (!group || Object.entries(normalized).every(([field, value]) => group[field as keyof TabGroup] === value)) return current
      return current.map((candidate) => candidate.id === id ? { ...candidate, ...normalized } : candidate)
    })
  }

  const ungroup = (id: string) => setGroups((current) => current.filter((group) => group.id !== id))
  const restoreGroups = useCallback((restored: TabGroup[]) => setGroups(restored), [])
  return { groups, createGroup, moveTabs, updateGroup, ungroup, restoreGroups }
}
