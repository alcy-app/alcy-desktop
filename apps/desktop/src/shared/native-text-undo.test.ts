import { afterEach, describe, expect, it, vi } from 'vitest'
import { installNativeTextUndo, isLinuxWebView } from './native-text-undo'

describe('installNativeTextUndo', () => {
  let uninstall = () => {}
  afterEach(() => {
    uninstall()
    document.body.innerHTML = ''
  })

  function setup(element: HTMLElement) {
    const runCommand = vi.fn()
    uninstall = installNativeTextUndo(document, runCommand)
    document.body.append(element)
    return runCommand
  }

  function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(event)
    return event
  }

  it('undoes with Ctrl+Z and redoes with Ctrl+Y or Ctrl+Shift+Z in inputs and textareas', () => {
    const input = document.createElement('input')
    const runCommand = setup(input)
    const textarea = document.createElement('textarea')
    document.body.append(textarea)

    expect(press(input, { key: 'z', ctrlKey: true }).defaultPrevented).toBe(true)
    press(textarea, { key: 'y', ctrlKey: true })
    press(input, { key: 'Z', ctrlKey: true, shiftKey: true })

    expect(runCommand.mock.calls).toEqual([['undo'], ['redo'], ['redo']])
  })

  it('leaves events another handler took, other elements and other keys alone', () => {
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    const runCommand = setup(editor)
    const input = document.createElement('input')
    document.body.append(input)
    input.addEventListener('keydown', (event) => {
      if (event.key === 'x') return
      if (event.altKey) return
      event.preventDefault()
    })

    press(editor, { key: 'z', ctrlKey: true })
    press(input, { key: 'z', ctrlKey: true })
    press(input, { key: 'z', ctrlKey: true, altKey: true })
    press(input, { key: 'x', ctrlKey: true })

    expect(runCommand).not.toHaveBeenCalled()
  })
})

describe('isLinuxWebView', () => {
  it('matches the Linux webview and nothing else', () => {
    expect(isLinuxWebView('Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)')).toBe(true)
    expect(isLinuxWebView('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/120.0')).toBe(false)
    expect(isLinuxWebView('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36')).toBe(false)
  })
})
