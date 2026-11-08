/** One stroke of a row of the graph, between lanes. */
export interface GraphLine {
  fromLane: number
  toLane: number
  /** Upper half (into the commit) or lower half (out of it). */
  half: 'top' | 'bottom'
  /** Lane whose color it takes. */
  colorLane: number
}

export interface GraphRow {
  lane: number
  lines: GraphLine[]
}

export interface GraphCommit {
  id: string
  parents: string[]
}

export interface Graph {
  rows: GraphRow[]
  /** Lanes the widest row needs. */
  width: number
}

function freeLane(lanes: Array<string | null>): number {
  const free = lanes.indexOf(null)
  return free === -1 ? lanes.length : free
}

/**
 * Lays commits (newest first) out in lanes. Each lane holds the commit it is
 * waiting for: a commit takes the lane expecting it (or a free one), every
 * other lane expecting it ends there, and its parents continue downwards.
 */
export function layoutGraph(commits: GraphCommit[]): Graph {
  let lanes: Array<string | null> = []
  let width = 0
  const rows = commits.map(({ id, parents }): GraphRow => {
    const expected = lanes.indexOf(id)
    const lane = expected === -1 ? freeLane(lanes) : expected
    const before = lanes
    const after = before.map((waiting) => (waiting === id ? null : waiting))
    while (after.length <= lane) after.push(null)
    after[lane] = parents[0] ?? null
    for (const parent of parents.slice(1)) {
      if (!after.includes(parent)) after[freeLane(after)] = parent
    }

    const lines: GraphLine[] = []
    before.forEach((waiting, index) => {
      if (waiting === null) return
      if (waiting === id) {
        lines.push({ fromLane: index, toLane: lane, half: 'top', colorLane: index })
      } else {
        lines.push({ fromLane: index, toLane: index, half: 'top', colorLane: index })
        lines.push({ fromLane: index, toLane: index, half: 'bottom', colorLane: index })
      }
    })
    for (const parent of parents) {
      const target = after.indexOf(parent)
      lines.push({ fromLane: lane, toLane: target, half: 'bottom', colorLane: target })
    }

    while (after.length > 0 && after[after.length - 1] === null) after.pop()
    width = Math.max(width, before.length, after.length, lane + 1)
    lanes = after
    return { lane, lines }
  })
  return { rows, width }
}
