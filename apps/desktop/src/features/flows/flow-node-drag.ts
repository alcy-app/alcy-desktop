import type { MouseEvent as ReactMouseEvent } from 'react'

/** Re-dispatch a press from screen-space content on the graph chassis, which owns native node dragging. */
export function startNodeDragFromChassis(chassis: HTMLDivElement | null, event: ReactMouseEvent<HTMLElement>) {
  const view = chassis?.ownerDocument.defaultView
  if (!chassis || !view || event.button !== 0 || event.ctrlKey) return
  const press = new view.MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: 1,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
  })
  // Set the source view directly: jsdom rejects its own window in the constructor while browsers accept it.
  Object.defineProperty(press, 'view', { value: view })
  chassis.dispatchEvent(press)
}
