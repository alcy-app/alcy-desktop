import { invoke } from '@tauri-apps/api/core'

/**
 * Shows a system notification and asks for attention (taskbar flash), only
 * while the app window is not focused. Resolves whether it was shown; a
 * failure only means no notification.
 */
export async function notifyWhenUnfocused(title: string, body: string): Promise<boolean> {
  try {
    return await invoke<boolean>('notify_when_unfocused', { input: { title, body } })
  } catch {
    return false
  }
}
