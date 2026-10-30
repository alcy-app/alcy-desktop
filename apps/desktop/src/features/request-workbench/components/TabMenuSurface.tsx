import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Keep tab menus in the viewport, outside the horizontally scrolling strip. */
export function TabMenuSurface({ x, y, label, onClose, children, dialog = false }: {
  x: number
  y: number
  label: string
  onClose: () => void
  children: ReactNode
  dialog?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const close = () => closeRef.current()
    const position = () => {
      menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`
      menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(menu)
    const closeOutside = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node)) close()
    }
    const closeScroll = (event: Event) => {
      if (!menu.contains(event.target as Node)) close()
    }
    window.addEventListener('pointerdown', closeOutside)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', closeScroll, true)
    const focus = menu.querySelector<HTMLElement>('[autofocus], input, button:not(:disabled)')
    focus?.focus({ preventScroll: true })
    if (focus instanceof HTMLInputElement) focus.select()
    return () => {
      observer.disconnect()
      window.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', closeScroll, true)
      const ownedFocus = menu.contains(document.activeElement)
      // Restore after removal so focus does not dispatch blur updates during React's commit.
      queueMicrotask(() => {
        if (ownedFocus && !menu.isConnected && origin?.isConnected && document.activeElement === document.body) {
          origin.focus({ preventScroll: true })
        }
      })
    }
  }, [x, y])

  return createPortal(
    <div
      ref={ref}
      className="ui-menu rw-tab-context-menu"
      role={dialog ? 'dialog' : 'menu'}
      aria-label={label}
      style={{ left: x, top: y }}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) onClose()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose(); return }
        if (event.target instanceof HTMLInputElement) return
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        if (!buttons.length) return
        event.preventDefault()
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next].focus()
      }}
    >{children}</div>,
    document.body,
  )
}
