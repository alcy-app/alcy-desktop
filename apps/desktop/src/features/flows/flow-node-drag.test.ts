import type { MouseEvent as ReactMouseEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { startNodeDragFromChassis } from './flow-node-drag'

function press(overrides: Partial<ReactMouseEvent<HTMLElement>> = {}) {
  return {
    button: 0,
    ctrlKey: false,
    clientX: 10,
    clientY: 20,
    screenX: 30,
    screenY: 40,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  } as ReactMouseEvent<HTMLElement>
}

describe('startNodeDragFromChassis', () => {
  it('forwards a left press with its coordinates to the chassis', () => {
    const chassis = document.createElement('div')
    const dispatch = vi.spyOn(chassis, 'dispatchEvent')

    startNodeDragFromChassis(chassis, press())

    expect(dispatch).toHaveBeenCalledOnce()
    const forwarded = dispatch.mock.calls[0][0] as MouseEvent
    expect([forwarded.type, forwarded.button, forwarded.clientX, forwarded.clientY]).toEqual(['mousedown', 0, 10, 20])
  })

  it('ignores right and control-modified presses so they keep their own meaning', () => {
    const chassis = document.createElement('div')
    const dispatch = vi.spyOn(chassis, 'dispatchEvent')

    startNodeDragFromChassis(chassis, press({ button: 2 }))
    startNodeDragFromChassis(chassis, press({ ctrlKey: true }))

    expect(dispatch).not.toHaveBeenCalled()
  })
})
