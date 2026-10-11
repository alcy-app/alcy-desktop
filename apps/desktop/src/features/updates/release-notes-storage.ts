const STORAGE_KEY = 'alcy:release-notes:seen-version'

/**
 * Registra que as novidades de `version` já foram mostradas. Devolve `true`
 * só na primeira vez que o app abre nessa versão.
 */
export function markReleaseNotesSeen(version: string): boolean {
  try {
    if (window.localStorage.getItem(STORAGE_KEY) === version) return false
    window.localStorage.setItem(STORAGE_KEY, version)
    return true
  } catch {
    // Sem storage não há como lembrar; melhor não abrir a aba a cada início.
    return false
  }
}
