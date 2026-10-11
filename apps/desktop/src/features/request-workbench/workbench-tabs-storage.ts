const STORAGE_PREFIX = 'alcy:workbench-tabs:'

/** Formato legado das abas abertas, só com ids de requisições salvas. Foi substituído pela sessão
 * de abas no workspace (ADR 0039) e só é lido uma vez, para migrar. */
export interface LegacyTabsState {
  openRequestIds: string[]
  activeRequestId: string | null
}

/** `null` quando o workspace não tem a lista legada (ou ela está ilegível). */
export function loadLegacyTabs(workspaceRootPath: string): LegacyTabsState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + workspaceRootPath)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LegacyTabsState>
    if (!Array.isArray(parsed.openRequestIds)) return null
    return {
      openRequestIds: parsed.openRequestIds.filter((id): id is string => typeof id === 'string'),
      activeRequestId: typeof parsed.activeRequestId === 'string' ? parsed.activeRequestId : null,
    }
  } catch {
    return null
  }
}

/** Remove a lista legada depois que a sessão foi gravada no workspace. */
export function clearLegacyTabs(workspaceRootPath: string): void {
  try {
    window.localStorage.removeItem(STORAGE_PREFIX + workspaceRootPath)
  } catch {
    // Sem acesso ao armazenamento: a lista legada só seria lida de novo sem arquivo de sessão.
  }
}
