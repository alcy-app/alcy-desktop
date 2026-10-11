import { useEffect, useState } from 'react'
import type { WorkspaceDto } from './bindings/create-workspace'
import { listRecentWorkspaces } from './bindings/list-recent-workspaces'
import { onWindowCloseRequested } from './bindings/on-window-close-requested'
import { openWorkspace } from './bindings/open-workspace'
import { removeWorkspace } from './bindings/remove-workspace'
import { RequestWorkbench } from './features/request-workbench/RequestWorkbench'
import { StartScreen } from './features/start-screen/StartScreen'
import { UpdateProvider } from './features/updates/UpdateProvider'
import { runBeforeExit } from './shared/app-lifecycle/before-exit'
import { ThemeProvider } from './shared/appearance/ThemeProvider'
import { UiScaleProvider } from './shared/appearance/UiScaleProvider'
import { SchemaAutocompleteProvider } from './shared/schema-autocomplete/SchemaAutocompleteProvider'
import { LanguageProvider } from './shared/i18n/LanguageProvider'
import { GitlabProvider } from './shared/gitlab/GitlabProvider'
import { ProxyProvider } from './shared/proxy/ProxyProvider'
import { SecurityPreferencesProvider } from './shared/security/SecurityPreferencesProvider'
import { ShortcutsProvider } from './shared/shortcuts/ShortcutsProvider'
import { ToastProvider } from './shared/ui/Toast'
import { Spinner } from './shared/ui/icons'
import { logger } from './shared/logging/logger'

type AppState =
  | { screen: 'checking' }
  | { screen: 'start' }
  | { screen: 'workbench'; workspace: WorkspaceDto }

/**
 * Tenta reabrir o workspace usado mais recentemente. Se a pasta não
 * existir mais (movida/apagada fora do Alcy), esquece essa entrada e
 * tenta a próxima — só cai na tela inicial se nenhum recente abrir.
 */
async function reopenLastWorkspace(): Promise<WorkspaceDto | null> {
  const recents = await listRecentWorkspaces()
  if (!recents.ok) return null

  for (const entry of recents.value) {
    const opened = await openWorkspace({ rootPath: entry.rootPath })
    if (opened.ok) return opened.value

    logger.warn('app', `workspace recente não abriu (${opened.error.kind}); removido dos recentes`)
    await removeWorkspace({ rootPath: entry.rootPath, deleteFiles: false })
  }

  return null
}

function AppScreens() {
  const [state, setState] = useState<AppState>({ screen: 'checking' })

  useEffect(() => {
    let cancelled = false

    void reopenLastWorkspace().then((workspace) => {
      if (cancelled) return
      setState(workspace ? { screen: 'workbench', workspace } : { screen: 'start' })
    })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    logger.info('app', `tela: ${state.screen}`)
  }, [state.screen])

  // Um único listener de fechamento: cada listener do Tauri destrói a janela assim que o próprio
  // handler termina, então com mais de um o mais rápido fecharia o app antes de os outros
  // gravarem. Quem precisa gravar algo antes de sair usa `registerBeforeExit`.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let disposed = false
    void onWindowCloseRequested(runBeforeExit).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  return (
    <>
      {state.screen === 'checking' && (
        <div className="app-loading" role="status" aria-label="Alcy">
          <Spinner size={18} />
          <span>Alcy</span>
        </div>
      )}
      {state.screen === 'start' && (
        <StartScreen onWorkspaceReady={(workspace) => setState({ screen: 'workbench', workspace })} />
      )}
      {state.screen === 'workbench' && (
        <RequestWorkbench
          key={state.workspace.rootPath}
          workspace={state.workspace}
          onWorkspaceChange={(workspace) => setState({ screen: 'workbench', workspace })}
          onExitToStartScreen={() => setState({ screen: 'start' })}
        />
      )}
    </>
  )
}

function App() {
  return (
    <ThemeProvider>
      <UiScaleProvider>
        <LanguageProvider>
          <ToastProvider>
            <SecurityPreferencesProvider>
              <ShortcutsProvider>
                <ProxyProvider>
                  <GitlabProvider>
                    <UpdateProvider>
                      <SchemaAutocompleteProvider>
                        <AppScreens />
                      </SchemaAutocompleteProvider>
                    </UpdateProvider>
                  </GitlabProvider>
                </ProxyProvider>
              </ShortcutsProvider>
            </SecurityPreferencesProvider>
          </ToastProvider>
        </LanguageProvider>
      </UiScaleProvider>
    </ThemeProvider>
  )
}

export default App
