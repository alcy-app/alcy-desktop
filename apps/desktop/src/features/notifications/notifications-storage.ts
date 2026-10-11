const READ_KEY = 'alcy:notifications:read'
const DISMISSED_KEY = 'alcy:notifications:dismissed'

/** Lista de ids salva; vazia quando o storage está indisponível ou corrompido. */
function loadIds(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function saveIds(key: string, ids: string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(ids))
  } catch {
    // Sem storage o estado volta ao padrão na próxima abertura; não há o que fazer.
  }
}

/** Ids já lidos. */
export function loadReadIds(): string[] {
  return loadIds(READ_KEY)
}

export function saveReadIds(ids: string[]): void {
  saveIds(READ_KEY, ids)
}

/** Ids dispensados pelo botão de fechar do card; não voltam a aparecer. */
export function loadDismissedIds(): string[] {
  return loadIds(DISMISSED_KEY)
}

export function saveDismissedIds(ids: string[]): void {
  saveIds(DISMISSED_KEY, ids)
}
