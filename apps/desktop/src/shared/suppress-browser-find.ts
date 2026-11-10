/**
 * WebView2 (the Tauri webview on Windows) opens the browser's own find bar
 * on Ctrl+F, F3 or Ctrl+G when no component handled the key, which makes the
 * app look like a web page. Editors with their own search handle Ctrl+F and
 * call `preventDefault`. This listener sits on `window` in the bubble phase,
 * after every listener on `document` (app shortcuts such as Ctrl+G skip
 * cancelled events), and cancels whatever is left, so the browser never
 * sees it.
 *
 * Returns the function that removes the listener (used in tests).
 */
export function installBrowserFindSuppression(target: Window = window): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.defaultPrevented && isBrowserFindKey(event)) event.preventDefault()
  }
  target.addEventListener('keydown', onKeyDown)
  return () => target.removeEventListener('keydown', onKeyDown)
}

function isBrowserFindKey(event: KeyboardEvent): boolean {
  if (event.altKey || event.metaKey) return false
  if (event.key === 'F3') return !event.ctrlKey
  if (!event.ctrlKey) return false
  const key = event.key.toLowerCase()
  return (key === 'f' && !event.shiftKey) || key === 'g'
}
