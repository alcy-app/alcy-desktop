import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { arrangeGroupedTabs, moveTabsToGroup, parseTabGroups } from './tab-groups'
import type { TabGroup } from './tab-groups'
import type { OpenTabDescriptor } from './use-open-tabs'
import { useTabGroups } from './use-tab-groups'

const group: TabGroup = { id: 'group', name: 'Payments', color: 'blue', collapsed: true, tabIds: ['a', 'b'] }
const tab = (id: string, fixed = false): OpenTabDescriptor => ({ id, kind: 'request', label: id, fixed, dirty: false, preview: false })

describe('tab groups', () => {
  it('isolates corrupt groups and enforces unique, existing, movable memberships', () => {
    expect(parseTabGroups([
      null,
      { ...group, color: 'unknown' },
      { ...group, tabIds: ['a', 'a', 'missing', 'b'] },
      { ...group, name: 'Duplicate ID', tabIds: ['c'] },
      { ...group, id: 'other', tabIds: ['b', 'c'] },
      { ...group, id: 'empty', tabIds: ['missing'] },
    ], new Set(['a', 'b', 'c']))).toEqual([group, { ...group, id: 'other', tabIds: ['c'] }])
  })

  it('keeps a group contiguous and honors its internal order without moving fixed tabs', () => {
    const tabs = [tab('fixed', true), tab('a'), tab('outside'), tab('b'), tab('last')]
    expect(arrangeGroupedTabs(tabs, [{ ...group, tabIds: ['b', 'a'] }]).map((item) => item.id))
      .toEqual(['fixed', 'b', 'a', 'outside', 'last'])
  })

  it('moves multiple members atomically and removes emptied source groups', () => {
    const other = { ...group, id: 'other', tabIds: ['c', 'd'] }
    expect(moveTabsToGroup([group, other], ['a', 'b'], 'other', 'd', 'before'))
      .toEqual([{ ...other, tabIds: ['c', 'a', 'b', 'd'] }])
    expect(moveTabsToGroup([group], ['a', 'b'], null)).toEqual([])
    expect(moveTabsToGroup([group], ['a'], 'group', 'a', 'before')).toEqual([group])
  })

  it('promotes previews and reconciles closing, fixing and reopening tabs', () => {
    const pin = vi.fn()
    const { result, rerender } = renderHook(({ tabs }) => useTabGroups(tabs, pin), { initialProps: { tabs: [tab('a'), tab('b'), tab('fixed', true)] } })
    act(() => { result.current.createGroup(['a', 'b', 'fixed'], 'Payments') })
    const id = result.current.groups[0].id
    expect(pin.mock.calls).toEqual([['a'], ['b']])
    act(() => result.current.updateGroup(id, { collapsed: true, name: '  Billing  ' }))
    expect(result.current.groups[0]).toMatchObject({ collapsed: true, name: 'Billing' })
    rerender({ tabs: [tab('b', true)] })
    expect(result.current.groups).toEqual([])
    rerender({ tabs: [tab('a'), tab('b')] })
    expect(result.current.groups).toEqual([])
  })
})
