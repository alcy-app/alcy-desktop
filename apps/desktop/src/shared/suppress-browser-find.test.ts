import { afterEach, describe, expect, it } from 'vitest'
import { installBrowserFindSuppression } from './suppress-browser-find'

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  document.body.dispatchEvent(event)
  return event
}

describe('installBrowserFindSuppression', () => {
  let uninstall = () => {}
  afterEach(() => uninstall())

  it('cancels the browser find keys nothing else handled', () => {
    uninstall = installBrowserFindSuppression()

    expect(press({ key: 'f', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(press({ key: 'F3' }).defaultPrevented).toBe(true)
    expect(press({ key: 'F3', shiftKey: true }).defaultPrevented).toBe(true)
    expect(press({ key: 'g', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(press({ key: 'G', ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true)
  })

  it('leaves other keys alone, including the app shortcut Ctrl+Shift+F', () => {
    uninstall = installBrowserFindSuppression()

    expect(press({ key: 'F', ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false)
    expect(press({ key: 'f' }).defaultPrevented).toBe(false)
    expect(press({ key: 'c', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(press({ key: 'f', ctrlKey: true, altKey: true }).defaultPrevented).toBe(false)
  })

  it('runs after document listeners, so app shortcuts still see the key unhandled', () => {
    uninstall = installBrowserFindSuppression()
    const seen: boolean[] = []
    const onKeyDown = (event: KeyboardEvent) => seen.push(event.defaultPrevented)
    document.addEventListener('keydown', onKeyDown)
    try {
      expect(press({ key: 'g', ctrlKey: true }).defaultPrevented).toBe(true)
      expect(seen).toEqual([false])
    } finally {
      document.removeEventListener('keydown', onKeyDown)
    }
  })
})
