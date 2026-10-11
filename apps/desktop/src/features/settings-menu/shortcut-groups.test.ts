import { describe, expect, it } from 'vitest'
import { SHORTCUT_ACTIONS } from '../../shared/shortcuts/shortcuts'
import { SHORTCUT_GROUPS } from './shortcut-groups'

describe('grupos de atalhos', () => {
  it('listam cada ação exatamente uma vez', () => {
    const grouped = SHORTCUT_GROUPS.flatMap((group) => group.actions)
    expect([...grouped].sort()).toEqual([...SHORTCUT_ACTIONS].sort())
  })
})
