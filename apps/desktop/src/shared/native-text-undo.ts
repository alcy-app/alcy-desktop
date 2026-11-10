/**
 * WebKitGTK (the Tauri webview on Linux) binds no keys to undo/redo in text
 * fields, unlike WebView2, which handles Ctrl+Z/Ctrl+Y in focused inputs.
 * This listener runs the editing command for native `<input>`/`<textarea>`
 * fields. It listens in the bubble phase and skips handled events, so code
 * editors (CodeMirror), which undo through their own history and call
 * `preventDefault`, keep it: WebKit's own undo stack does not know their
 * pastes, line breaks or completions.
 *
 * Ctrl+Z undoes; Ctrl+Y and Ctrl+Shift+Z redo. Returns the function that
 * removes the listener (used in tests).
 */
export function installNativeTextUndo(
  target: Document = document,
  runCommand: (command: 'undo' | 'redo') => void = (command) => {
    // Deprecated, but the only way to reach the field's native undo stack from the page.
    target.execCommand(command)
  },
): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !event.ctrlKey || event.altKey || event.metaKey) return
    const command = historyCommandFor(event.key.toLowerCase(), event.shiftKey)
    if (!command) return
    if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) return
    event.preventDefault()
    runCommand(command)
  }
  target.addEventListener('keydown', onKeyDown)
  return () => target.removeEventListener('keydown', onKeyDown)
}

function historyCommandFor(key: string, shift: boolean): 'undo' | 'redo' | null {
  if (key === 'z') return shift ? 'redo' : 'undo'
  if (key === 'y' && !shift) return 'redo'
  return null
}

/** The desktop app on Linux runs in WebKitGTK, the only webview without the keys. */
export function isLinuxWebView(userAgent: string = navigator.userAgent): boolean {
  return /\bLinux\b/.test(userAgent) && !/\bAndroid\b/.test(userAgent)
}
