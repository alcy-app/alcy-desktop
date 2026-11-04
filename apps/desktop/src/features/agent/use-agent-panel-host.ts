import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * One element the agent panel renders into (through a portal) for as long as
 * the workbench lives, moved into `target` — beside the main area, below it,
 * or a sidebar module (spec 0143). React keeps the panel's state because the
 * portal's container never changes; only where that container sits does.
 *
 * Moving a node out of the document resets the scroll of everything inside
 * it, so scroll positions are tracked while it is attached and put back once
 * it lands somewhere else.
 */
export function useAgentPanelHost(target: HTMLElement | null): HTMLDivElement {
  const [host] = useState(() => {
    const element = document.createElement('div')
    element.className = 'agent-panel-host'
    return element
  })
  const scrollPositionsRef = useRef(new Map<Element, number>())

  useEffect(() => {
    const scrollPositions = scrollPositionsRef.current
    const remember = (event: Event) => {
      if (event.target instanceof Element) scrollPositions.set(event.target, event.target.scrollTop)
    }
    // Scroll events do not bubble; capturing on the host sees every inner scroller.
    host.addEventListener('scroll', remember, true)
    return () => host.removeEventListener('scroll', remember, true)
  }, [host])

  useLayoutEffect(() => {
    if (!target || host.parentElement === target) return
    target.appendChild(host)
    const scrollPositions = scrollPositionsRef.current
    for (const [element, scrollTop] of scrollPositions) {
      if (!host.contains(element)) scrollPositions.delete(element)
      else element.scrollTo({ top: scrollTop })
    }
  }, [host, target])

  // The workbench going away takes the panel with it.
  useEffect(() => () => host.remove(), [host])

  return host
}
