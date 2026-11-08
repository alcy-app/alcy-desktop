import { describe, expect, it } from 'vitest'
import { layoutGraph } from './git-graph'

describe('layoutGraph', () => {
  it('keeps a straight history in one lane', () => {
    const { rows, width } = layoutGraph([
      { id: 'c', parents: ['b'] },
      { id: 'b', parents: ['a'] },
      { id: 'a', parents: [] },
    ])
    expect(width).toBe(1)
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0])
    expect(rows[0].lines).toEqual([{ fromLane: 0, toLane: 0, half: 'bottom', colorLane: 0 }])
    expect(rows[2].lines).toEqual([{ fromLane: 0, toLane: 0, half: 'top', colorLane: 0 }])
  })

  it('opens a lane for the merged branch and closes it at the fork', () => {
    const { rows, width } = layoutGraph([
      { id: 'merge', parents: ['ours', 'theirs'] },
      { id: 'ours', parents: ['base'] },
      { id: 'theirs', parents: ['base'] },
      { id: 'base', parents: [] },
    ])
    expect(width).toBe(2)
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 1, 0])
    expect(rows[0].lines).toContainEqual({ fromLane: 0, toLane: 1, half: 'bottom', colorLane: 1 })
    // The second lane runs past "ours" and ends in "base".
    expect(rows[1].lines).toContainEqual({ fromLane: 1, toLane: 1, half: 'bottom', colorLane: 1 })
    expect(rows[3].lines).toContainEqual({ fromLane: 1, toLane: 0, half: 'top', colorLane: 1 })
  })

  it('gives unrelated tips their own lane and tolerates parents outside the page', () => {
    const { rows, width } = layoutGraph([
      { id: 'upstream', parents: ['base'] },
      { id: 'local', parents: ['other'] },
      { id: 'older', parents: ['not-loaded'] },
    ])
    expect(rows.map((row) => row.lane)).toEqual([0, 1, 2])
    expect(width).toBe(3)
  })
})
