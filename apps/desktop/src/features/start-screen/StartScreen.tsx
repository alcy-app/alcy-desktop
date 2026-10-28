import { useState } from 'react'
import type { WorkspaceDto } from '../../bindings/create-workspace'
import { FEATURE_FLAGS } from '../../shared/feature-flags'
import { useLanguage } from '../../shared/i18n/use-language'
import { useOnedrive } from '../../shared/onedrive/use-onedrive'
import { Button } from '../../shared/ui/Button'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { TitleBar } from '../../shared/ui/TitleBar'
import { workspaceErrorMessageKey } from '../../shared/workspace-command-error'
import { TeamWorkspaceDialog } from './TeamWorkspaceDialog'
import { useStartScreenState } from './use-start-screen-state'
import alcyIcon from '../../assets/alcy-icon.svg'
import './start-screen.css'

interface StartScreenProps {
  onWorkspaceReady: (workspace: WorkspaceDto) => void
}

export function StartScreen({ onWorkspaceReady }: StartScreenProps) {
  const { t } = useLanguage()
  const { recentWorkspaces, busy, error, create, openPicked, openRecent } = useStartScreenState(onWorkspaceReady)
  const { accounts: onedriveAccounts } = useOnedrive()
  const [teamDialogOpen, setTeamDialogOpen] = useState(false)
  const teamWorkspacesAvailable = FEATURE_FLAGS.onedrive && onedriveAccounts.length > 0

  return (
    <div className="start-screen-shell">
      <TitleBar />
      <div className="start-screen">
        <div className="start-screen-card">
          <img className="start-screen-logo" src={alcyIcon} alt="" aria-hidden="true" />
          <h1 className="start-screen-brand">Alcy</h1>
          <p className="start-screen-kicker">{t('startScreen.kicker')}</p>
          <p className="start-screen-tagline">{t('startScreen.tagline')}</p>

          <div className="start-screen-actions">
            <Button
              variant="primary"
              size="md"
              className="start-screen-action"
              onClick={() => void create()}
              disabled={busy !== 'idle'}
            >
              {busy === 'creating' ? t('startScreen.creating') : t('startScreen.createButton')}
            </Button>
            <Button
              variant="ghost"
              size="md"
              className="start-screen-action"
              onClick={() => void openPicked()}
              disabled={busy !== 'idle'}
            >
              {busy === 'opening' ? t('startScreen.opening') : t('startScreen.openButton')}
            </Button>
            {teamWorkspacesAvailable && (
              <Button
                variant="ghost"
                size="md"
                className="start-screen-action"
                onClick={() => setTeamDialogOpen(true)}
                disabled={busy !== 'idle'}
              >
                {t('startScreen.teamButton')}
              </Button>
            )}
            <Button variant="ghost" size="md" className="start-screen-action" disabled aria-disabled="true">
              {t('startScreen.importButton')}
            </Button>
          </div>

          {error && (
            <InlineAlert className="start-screen-error">
              {t(workspaceErrorMessageKey(error), { message: error.message })}
            </InlineAlert>
          )}

          {recentWorkspaces.length > 0 && (
            <div className="start-screen-recent">
              <p className="start-screen-recent-title">{t('startScreen.recentTitle')}</p>
              <ul className="start-screen-recent-list">
                {recentWorkspaces.map((workspace) => (
                  <li key={workspace.rootPath}>
                    <button
                      type="button"
                      className="start-screen-recent-item"
                      onClick={() => void openRecent(workspace.rootPath)}
                      disabled={busy !== 'idle'}
                      aria-label={t('startScreen.openRecentAria', { name: workspace.name })}
                    >
                      <span className="start-screen-recent-name">{workspace.name}</span>
                      <span className="start-screen-recent-path">{workspace.rootPath}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="start-screen-footer">{t('startScreen.footerNote')}</p>
        </div>
        {teamDialogOpen && (
          <TeamWorkspaceDialog onClose={() => setTeamDialogOpen(false)} onWorkspaceReady={onWorkspaceReady} />
        )}
      </div>
    </div>
  )
}
