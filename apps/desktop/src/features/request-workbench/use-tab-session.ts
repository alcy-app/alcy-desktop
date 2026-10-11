import { useCallback, useEffect, useRef, useState } from 'react'
import { loadTabSession } from '../../bindings/load-tab-session'
import { saveTabSession } from '../../bindings/save-tab-session'
import { registerBeforeExit } from '../../shared/app-lifecycle/before-exit'
import type { RequestContent, TreeNode } from './collection-tree'
import type { WorkbenchTab } from './request-workbench.types'
import { parseTabSession, resolveTabSession, sessionFromLegacy, snapshotTabSession } from './tab-session'
import type { RestoredTab, TabSession } from './tab-session'
import { clearLegacyTabs, loadLegacyTabs } from './workbench-tabs-storage'

const SAVE_DEBOUNCE_MS = 800

interface UseTabSessionOptions {
  rootPath: string
  tabs: WorkbenchTab[]
  activeTabId: string | null
  collections: TreeNode[]
  collectionsLoaded: boolean
  contentOf: (tab: WorkbenchTab) => RequestContent
  restoreTabs: (tabs: RestoredTab[], activeTabId: string | null) => void
}

/**
 * Sessão de abas do workspace (ADR 0039): restaura as abas abertas, inclusive as não salvas, assim
 * que sessão e coleções estão carregadas, e grava de volta com debounce a cada mudança. Fechar a
 * janela, trocar de workspace (desmontagem) e reiniciar para atualizar gravam o que está pendente.
 *
 * `restored` fica `false` até a restauração rodar. Antes disso não dá para saber se a tela vazia
 * é real, e nada é gravado, para não sobrescrever a sessão com uma lista ainda vazia.
 */
export function useTabSession({
  rootPath,
  tabs,
  activeTabId,
  collections,
  collectionsLoaded,
  contentOf,
  restoreTabs,
}: UseTabSessionOptions) {
  // `undefined` enquanto carrega; `null` quando não há sessão (nem legada) para restaurar.
  const [session, setSession] = useState<TabSession | null | undefined>(undefined)
  const [restored, setRestored] = useState(false)
  const restoredRef = useRef(false)
  const legacyPendingRef = useRef(false)
  const lastSavedRef = useRef<string | null>(null)
  const saveTimeoutRef = useRef<number | null>(null)
  const latestRef = useRef({ tabs, activeTabId, contentOf })

  useEffect(() => {
    latestRef.current = { tabs, activeTabId, contentOf }
  }, [tabs, activeTabId, contentOf])

  useEffect(() => {
    let cancelled = false
    void loadTabSession(rootPath).then((result) => {
      if (cancelled) return
      if (result.ok && result.value !== null) {
        const parsed = parseTabSession(result.value)
        if (parsed !== null) {
          // A comparação parte do snapshot já persistido. Assim, só abrir o workspace (ou
          // executar uma requisição, que não muda o snapshot) não regrava o mesmo arquivo.
          lastSavedRef.current = JSON.stringify({ version: 1, ...parsed })
        }
        setSession(parsed)
        return
      }
      // Sem arquivo ainda: migra a lista legada do `localStorage`, se houver. Um arquivo ilegível
      // não impede a abertura; ele é substituído na próxima gravação.
      const legacy = result.ok ? loadLegacyTabs(rootPath) : null
      legacyPendingRef.current = legacy !== null
      setSession(legacy === null ? null : sessionFromLegacy(legacy))
    })
    return () => {
      cancelled = true
    }
  }, [rootPath])

  useEffect(() => {
    if (restoredRef.current || session === undefined || !collectionsLoaded) return
    restoredRef.current = true
    if (session !== null) restoreTabs(resolveTabSession(session, collections), session.activeTabId)
    setRestored(true)
  }, [session, collectionsLoaded, collections, restoreTabs])

  /** Grava agora o snapshot atual, se mudou desde a última gravação. */
  const flush = useCallback(async () => {
    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    if (!restoredRef.current) return

    const { tabs: currentTabs, activeTabId: currentActiveTabId, contentOf: currentContentOf } = latestRef.current
    const snapshot = snapshotTabSession(currentTabs, currentActiveTabId, currentContentOf)
    const serialized = JSON.stringify(snapshot)
    if (serialized === lastSavedRef.current) return

    lastSavedRef.current = serialized
    const result = await saveTabSession(rootPath, snapshot)
    if (!result.ok) {
      // Deixa a próxima mudança (ou o flush ao sair) tentar de novo.
      lastSavedRef.current = null
      return
    }
    if (legacyPendingRef.current) {
      legacyPendingRef.current = false
      clearLegacyTabs(rootPath)
    }
  }, [rootPath])

  useEffect(() => {
    if (!restored) return
    if (saveTimeoutRef.current !== null) window.clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = window.setTimeout(() => {
      saveTimeoutRef.current = null
      void flush()
    }, SAVE_DEBOUNCE_MS)
  }, [tabs, activeTabId, restored, flush])

  useEffect(() => {
    const unregister = registerBeforeExit(flush)
    return () => {
      unregister()
      void flush()
    }
  }, [flush])

  return { restored }
}
