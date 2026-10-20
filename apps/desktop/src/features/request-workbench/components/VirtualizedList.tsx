import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from 'react'

export interface VirtualizedListHandle {
  scrollToEnd: () => void
  scrollToKey: (key: string) => void
  isAtEnd: () => boolean
}

interface VirtualizedListProps<T> {
  items: T[]
  getKey: (item: T) => string
  estimatedRowHeight: number
  renderItem: (item: T) => ReactNode
  className?: string
  ariaLabel: string
  onScrollStateChange?: (atEnd: boolean) => void
}

const OVERSCAN_PX = 240
const END_THRESHOLD_PX = 20

function atEnd(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= END_THRESHOLD_PX
}

interface MeasuredRowProps {
  itemKey: string
  top: number
  onMeasure: (key: string, height: number) => void
  children: ReactNode
}

function MeasuredRow({ itemKey, top, onMeasure, children }: MeasuredRowProps) {
  const rowRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const element = rowRef.current
    if (!element) return
    const measure = () => onMeasure(itemKey, Math.ceil(element.getBoundingClientRect().height))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [children, itemKey, onMeasure])

  return (
    <div ref={rowRef} role="listitem" className="virtual-list-row" style={{ transform: `translateY(${top}px)` }}>
      {children}
    </div>
  )
}

/** Virtualized rows use measured heights, including expanded console entries. */
function VirtualizedListInner<T>(
  {
    items,
    getKey,
    estimatedRowHeight,
    renderItem,
    className,
    ariaLabel,
    onScrollStateChange,
  }: VirtualizedListProps<T>,
  ref: React.ForwardedRef<VirtualizedListHandle>,
) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [heights, setHeights] = useState(() => new Map<string, number>())
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(320)

  const measureRow = useCallback((key: string, height: number) => {
    if (height <= 0) return
    setHeights((current) => {
      if (current.get(key) === height) return current
      const next = new Map(current)
      next.set(key, height)
      return next
    })
  }, [])

  useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const measure = () => setViewportHeight(element.clientHeight || 320)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const layout = useMemo(() => {
    const offsets: number[] = []
    let totalHeight = 0
    for (const item of items) {
      offsets.push(totalHeight)
      totalHeight += heights.get(getKey(item)) ?? estimatedRowHeight
    }
    return { offsets, totalHeight }
  }, [estimatedRowHeight, getKey, heights, items])

  const startBoundary = Math.max(0, scrollTop - OVERSCAN_PX)
  const endBoundary = scrollTop + viewportHeight + OVERSCAN_PX
  let startIndex = 0
  while (
    startIndex < items.length &&
    layout.offsets[startIndex] + (heights.get(getKey(items[startIndex])) ?? estimatedRowHeight) < startBoundary
  ) {
    startIndex += 1
  }
  let endIndex = startIndex
  while (endIndex < items.length && layout.offsets[endIndex] < endBoundary) endIndex += 1

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    setScrollTop(element.scrollTop)
    onScrollStateChange?.(atEnd(element))
  }

  useImperativeHandle(
    ref,
    () => ({
      scrollToKey(key: string) {
        const element = viewportRef.current
        const index = items.findIndex((item) => getKey(item) === key)
        if (!element || index < 0) return
        const top = layout.offsets[index]
        if (top < element.scrollTop || top + estimatedRowHeight > element.scrollTop + element.clientHeight) {
          element.scrollTop = top
          setScrollTop(top)
        }
      },
      scrollToEnd() {
        const element = viewportRef.current
        if (!element) return
        element.scrollTop = element.scrollHeight
        setScrollTop(element.scrollTop)
        onScrollStateChange?.(true)
      },
      isAtEnd() {
        return viewportRef.current ? atEnd(viewportRef.current) : true
      },
    }),
    [onScrollStateChange, items, getKey, layout, estimatedRowHeight],
  )

  return (
    <div
      ref={viewportRef}
      role="list"
      aria-label={ariaLabel}
      className={['virtual-list', className].filter(Boolean).join(' ')}
      onScroll={handleScroll}
    >
      <div className="virtual-list-spacer" style={{ height: layout.totalHeight }}>
        {items.slice(startIndex, endIndex).map((item, visibleIndex) => {
          const index = startIndex + visibleIndex
          const key = getKey(item)
          return (
            <MeasuredRow key={key} itemKey={key} top={layout.offsets[index]} onMeasure={measureRow}>
              {renderItem(item)}
            </MeasuredRow>
          )
        })}
      </div>
    </div>
  )
}

export const VirtualizedList = forwardRef(VirtualizedListInner) as <T>(
  props: VirtualizedListProps<T> & { ref?: React.ForwardedRef<VirtualizedListHandle> },
) => ReactNode
