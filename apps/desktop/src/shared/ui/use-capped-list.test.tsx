import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '../../test-utils'
import { ResizeHandle } from '../ResizeHandle'
import { useCappedList } from './use-capped-list'

const ROW_HEIGHT = 20
const DEFAULT_ROWS = 10
const STORAGE_KEY = 'alcy:list:test'

function List({ count, current }: { count: number; current: number | null }) {
  const { listRef, separatorProps } = useCappedList<HTMLUListElement>({
    defaultRows: DEFAULT_ROWS,
    itemCount: count,
    currentKey: current === null ? null : String(current),
    storageKey: STORAGE_KEY,
  })
  return (
    <>
      <ul ref={listRef} aria-label="items" className="ui-capped-list">
        {Array.from({ length: count }, (_, index) => (
          <li key={index} data-index={index}>
            <button type="button" aria-current={index === current}>
              Item {index}
            </button>
          </li>
        ))}
      </ul>
      <ResizeHandle orientation="horizontal" ariaLabel="Resize" {...separatorProps} />
    </>
  )
}

// jsdom has no layout: give rows a fixed height and the list a height capped at its max-height.
const stubs: Array<[PropertyKey, PropertyDescriptor | undefined]> = []
function stub(name: 'offsetTop' | 'offsetHeight' | 'clientHeight' | 'scrollHeight', get: (this: HTMLElement) => number) {
  stubs.push([name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)])
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get })
}

beforeEach(() => {
  window.localStorage.removeItem(STORAGE_KEY)
  stub('offsetTop', function () {
    return Number(this.dataset.index ?? 0) * ROW_HEIGHT
  })
  stub('offsetHeight', () => ROW_HEIGHT)
  stub('scrollHeight', function () {
    return this.children.length * ROW_HEIGHT
  })
  stub('clientHeight', function () {
    const cap = Number.parseFloat(this.style.maxHeight)
    return Number.isNaN(cap) ? this.children.length * ROW_HEIGHT : cap
  })
})

afterEach(() => {
  for (const [name, descriptor] of stubs.splice(0).reverse()) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else Reflect.deleteProperty(HTMLElement.prototype, name)
  }
})

const list = () => screen.getByRole('list', { name: 'items' })
const separator = () => screen.getByRole('separator', { name: 'Resize' })

describe('useCappedList', () => {
  it('leaves a list within the limit uncapped', () => {
    render(<List count={DEFAULT_ROWS} current={0} />)
    expect(list().style.maxHeight).toBe('')
    expect(list()).not.toHaveAttribute('data-scrollable')
  })

  it('caps the height at the last visible row and marks the hidden edge', () => {
    render(<List count={DEFAULT_ROWS + 3} current={0} />)
    expect(list().style.maxHeight).toBe(`${DEFAULT_ROWS * ROW_HEIGHT}px`)
    expect(list()).toHaveAttribute('data-scrollable')
    expect(list()).toHaveAttribute('data-overflow-bottom')
    expect(list()).not.toHaveAttribute('data-overflow-top')
  })

  it('scrolls only the list to show the current row', () => {
    const { rerender } = render(<List count={DEFAULT_ROWS + 3} current={0} />)

    rerender(<List count={DEFAULT_ROWS + 3} current={DEFAULT_ROWS + 2} />)
    expect(list().scrollTop).toBe(3 * ROW_HEIGHT)

    rerender(<List count={DEFAULT_ROWS + 3} current={1} />)
    expect(list().scrollTop).toBe(ROW_HEIGHT)
  })

  it('drops the cap once rows are removed back to the limit', () => {
    const { rerender } = render(<List count={DEFAULT_ROWS + 1} current={0} />)
    rerender(<List count={DEFAULT_ROWS} current={0} />)
    expect(list().style.maxHeight).toBe('')
    expect(list()).not.toHaveAttribute('data-scrollable')
    expect(list()).not.toHaveAttribute('data-overflow-bottom')
  })

  it('previews the drag in whole rows and keeps the result on release', () => {
    // Capture the observer so it can fire mid-drag, as real layout changes do.
    const observers: Array<() => void> = []
    const original = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        observers.push(callback)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver

    try {
      render(<List count={DEFAULT_ROWS + 5} current={0} />)

      fireEvent.pointerDown(separator(), { button: 0, clientY: 300 })
      // Two rows down plus less than half of a third: the preview shows two more rows.
      fireEvent.pointerMove(window, { clientY: 300 + 2 * ROW_HEIGHT + 8 })
      expect(list().style.maxHeight).toBe(`${(DEFAULT_ROWS + 2) * ROW_HEIGHT}px`)
      // More than half of the third uncovered: it joins the preview.
      fireEvent.pointerMove(window, { clientY: 300 + 2 * ROW_HEIGHT + 12 })
      expect(list().style.maxHeight).toBe(`${(DEFAULT_ROWS + 3) * ROW_HEIGHT}px`)

      // The list resizing itself must not snap the preview back to the saved rows.
      for (const notify of observers) notify()
      expect(list().style.maxHeight).toBe(`${(DEFAULT_ROWS + 3) * ROW_HEIGHT}px`)

      fireEvent.pointerUp(window)
      expect(list().style.maxHeight).toBe(`${(DEFAULT_ROWS + 3) * ROW_HEIGHT}px`)
      expect(separator()).toHaveAttribute('aria-valuenow', String(DEFAULT_ROWS + 3))
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe(String(DEFAULT_ROWS + 3))
    } finally {
      globalThis.ResizeObserver = original
    }
  })

  it('never shrinks below one row', () => {
    render(<List count={DEFAULT_ROWS + 5} current={0} />)

    fireEvent.pointerDown(separator(), { button: 0, clientY: 300 })
    fireEvent.pointerMove(window, { clientY: -1000 })
    fireEvent.pointerUp(window)
    expect(list().style.maxHeight).toBe(`${ROW_HEIGHT}px`)
  })

  it('resizes one row at a time from the keyboard and resets on double-click', () => {
    render(<List count={DEFAULT_ROWS + 5} current={0} />)

    fireEvent.keyDown(separator(), { key: 'ArrowUp' })
    expect(list().style.maxHeight).toBe(`${(DEFAULT_ROWS - 1) * ROW_HEIGHT}px`)
    fireEvent.keyDown(separator(), { key: 'End' })
    expect(list().style.maxHeight).toBe('')
    expect(separator()).toHaveAttribute('aria-valuenow', String(DEFAULT_ROWS + 5))

    fireEvent.doubleClick(separator())
    expect(list().style.maxHeight).toBe(`${DEFAULT_ROWS * ROW_HEIGHT}px`)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('restores the saved number of rows', () => {
    window.localStorage.setItem(STORAGE_KEY, '4')
    render(<List count={DEFAULT_ROWS + 5} current={0} />)
    expect(list().style.maxHeight).toBe(`${4 * ROW_HEIGHT}px`)
  })
})
