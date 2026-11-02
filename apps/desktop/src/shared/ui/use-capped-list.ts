import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import './capped-list.css'

interface UseCappedListOptions {
  /** Rows shown before the list scrolls, until the user resizes it. */
  defaultRows: number
  itemCount: number
  /** Selected row id: when it changes, the list scrolls to the row marked `aria-current="true"`. */
  currentKey: string | null
  /** localStorage key keeping the number of rows the user chose. */
  storageKey: string
}

/**
 * Caps a list at a number of visible rows and lets the rest scroll inside it;
 * a divider (see `separatorProps`) changes that number by dragging or with the
 * arrow keys, and a double-click restores the default.
 *
 * Heights come from measuring the rendered rows, so the cap follows font
 * scale, density and multi-line rows, and a drag snaps to whole rows when
 * released. While the list overflows it gets `data-scrollable`, plus
 * `data-overflow-top` / `data-overflow-bottom` on the edges that hide rows;
 * the styles live in `capped-list.css` under `.ui-capped-list`.
 */
export function useCappedList<T extends HTMLElement>({ defaultRows, itemCount, currentKey, storageKey }: UseCappedListOptions) {
  const listRef = useRef<T>(null)
  const [visibleRows, setVisibleRows] = useState(() => loadRows(storageKey) ?? defaultRows)
  const [resizing, setResizing] = useState(false)
  const stopDragRef = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    // While dragging, the drag owns the height: re-measuring would snap it back to the saved rows.
    const measure = () => {
      if (!stopDragRef.current) applyCap(list, visibleRows)
    }
    measure()
    // Rows change height with font scale or wrapping; the list itself with the sidebar width.
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    for (const row of Array.from(list.children).slice(0, visibleRows)) observer.observe(row)
    const onScroll = () => updateEdges(list)
    list.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer.disconnect()
      list.removeEventListener('scroll', onScroll)
    }
  }, [visibleRows, itemCount])

  useLayoutEffect(() => {
    const list = listRef.current
    if (list?.hasAttribute('data-scrollable')) scrollRowIntoView(list)
  }, [currentKey, itemCount, visibleRows])

  // A drag interrupted by unmounting (switching sidebar tabs) must not leave window listeners behind.
  useEffect(() => () => stopDragRef.current?.(), [])

  const commitRows = useCallback(
    (rows: number) => {
      const list = listRef.current
      // Snap right away: state equal to the current value would not re-run the measuring effect.
      if (list) applyCap(list, rows)
      setVisibleRows(rows)
      saveRows(storageKey, rows)
    },
    [storageKey],
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      const list = listRef.current
      const rows = list ? (Array.from(list.children) as HTMLElement[]) : []
      if (!list || rows.length === 0 || event.button !== 0) return
      // Keep the drag from selecting text.
      event.preventDefault()
      const startY = event.clientY
      // Measure against the snapped height the list shows now, not one mid-transition.
      const startRows = Math.min(visibleRows, rows.length)
      const startHeight = rowBottom(rows[startRows - 1])
      let shown = startRows

      // The list previews the result while dragging: it follows the pointer in whole rows (a row
      // counts once half of it is uncovered) and the max-height transition smooths each step.
      const move = (moveEvent: PointerEvent) => {
        const height = startHeight + moveEvent.clientY - startY
        const next = Math.max(1, rows.filter((row) => row.offsetTop + row.offsetHeight / 2 <= height).length)
        if (next === shown) return
        shown = next
        previewRows(list, rows, shown)
      }
      const stop = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', release)
        window.removeEventListener('pointercancel', release)
        stopDragRef.current = null
      }
      const release = () => {
        stop()
        commitRows(shown)
        setResizing(false)
      }

      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', release)
      window.addEventListener('pointercancel', release)
      stopDragRef.current = stop
      // Start from an explicit height so even the first step animates (a "none" max-height cannot).
      previewRows(list, rows, shown)
      setResizing(true)
    },
    [commitRows, visibleRows],
  )

  const shownRows = Math.max(1, Math.min(visibleRows, itemCount))
  const lastRow = Math.max(1, itemCount)

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      const next =
        event.key === 'ArrowUp'
          ? shownRows - 1
          : event.key === 'ArrowDown'
            ? shownRows + 1
            : event.key === 'Home'
              ? 1
              : event.key === 'End'
                ? lastRow
                : null
      if (next === null) return
      event.preventDefault()
      commitRows(Math.min(lastRow, Math.max(1, next)))
    },
    [commitRows, lastRow, shownRows],
  )

  const onDoubleClick = useCallback(() => {
    const list = listRef.current
    if (list) applyCap(list, defaultRows)
    setVisibleRows(defaultRows)
    saveRows(storageKey, null)
  }, [defaultRows, storageKey])

  return {
    listRef,
    resizing,
    separatorProps: {
      onPointerDown,
      onKeyDown,
      onDoubleClick,
      'aria-valuenow': shownRows,
      'aria-valuemin': 1,
      'aria-valuemax': lastRow,
    },
  }
}

function applyCap(list: HTMLElement, visibleRows: number) {
  const rows = list.children
  if (rows.length <= visibleRows) {
    list.style.removeProperty('max-height')
    list.removeAttribute('data-scrollable')
  } else {
    list.style.maxHeight = `${rowBottom(rows[visibleRows - 1] as HTMLElement) + paddingOf(list, 'bottom')}px`
    list.setAttribute('data-scrollable', '')
  }
  updateEdges(list)
}

/** Shows `count` rows with an explicit height, even when that is every row, so changes animate. */
function previewRows(list: HTMLElement, rows: HTMLElement[], count: number) {
  list.style.maxHeight = `${rowBottom(rows[count - 1]) + paddingOf(list, 'bottom')}px`
  list.toggleAttribute('data-scrollable', count < rows.length)
  updateEdges(list)
}

function updateEdges(list: HTMLElement) {
  const scrollable = list.hasAttribute('data-scrollable')
  list.toggleAttribute('data-overflow-top', scrollable && list.scrollTop > 0)
  // One pixel of slack: fractional scaling can leave scrollTop just short of the end.
  list.toggleAttribute('data-overflow-bottom', scrollable && list.scrollTop + list.clientHeight < list.scrollHeight - 1)
}

/** Scroll only the list (scrollIntoView would also move the sidebar panel around it). */
function scrollRowIntoView(list: HTMLElement) {
  let row = list.querySelector<HTMLElement>('[aria-current="true"]')
  while (row && row.parentElement !== list) row = row.parentElement
  if (!row) return
  const top = row.offsetTop - paddingOf(list, 'top')
  const bottom = rowBottom(row) + paddingOf(list, 'bottom')
  if (top < list.scrollTop) list.scrollTop = top
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
}

function rowBottom(row: HTMLElement) {
  return row.offsetTop + row.offsetHeight
}

function paddingOf(list: HTMLElement, side: 'top' | 'bottom') {
  const style = getComputedStyle(list)
  return Number.parseFloat(side === 'top' ? style.paddingTop : style.paddingBottom) || 0
}

function loadRows(storageKey: string): number | null {
  try {
    const rows = Number(window.localStorage.getItem(storageKey))
    return Number.isInteger(rows) && rows >= 1 ? rows : null
  } catch {
    return null
  }
}

function saveRows(storageKey: string, rows: number | null) {
  try {
    if (rows === null) window.localStorage.removeItem(storageKey)
    else window.localStorage.setItem(storageKey, String(rows))
  } catch {
    // Storage failure affects persistence only; resizing keeps working in this session.
  }
}
