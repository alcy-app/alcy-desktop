import { useState } from 'react'
import type { WorkspaceDto } from '../../bindings/create-workspace'
import type { GitlabCommandError } from '../../bindings/gitlab-types'
import type { DriveFolderDto } from '../../bindings/onedrive-types'
import { openOnedriveTeamWorkspace } from '../../bindings/open-onedrive-team-workspace'
import { gitlabErrorMessage } from '../../shared/gitlab/gitlab-error-message'
import { useLanguage } from '../../shared/i18n/use-language'
import { TeamWorkspacePicker } from '../../shared/onedrive/TeamWorkspacePicker'
import { useOnedrive } from '../../shared/onedrive/use-onedrive'
import { Button } from '../../shared/ui/Button'
import { Field } from '../../shared/ui/Field'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { Modal } from '../../shared/ui/Modal'
import { Select } from '../../shared/ui/Select'

interface TeamWorkspaceDialogProps {
  onClose: () => void
  onWorkspaceReady: (workspace: WorkspaceDto) => void
}

/** Opens a workspace from one of the account's Teams: a local copy, linked and synced. */
export function TeamWorkspaceDialog({ onClose, onWorkspaceReady }: TeamWorkspaceDialogProps) {
  const { t } = useLanguage()
  const { accounts } = useOnedrive()
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [selected, setSelected] = useState<DriveFolderDto | null>(null)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<GitlabCommandError | null>(null)

  const open = async () => {
    if (!selected) return
    setOpening(true)
    setError(null)
    const result = await openOnedriveTeamWorkspace({
      operationId: crypto.randomUUID(),
      accountId,
      driveId: selected.driveId,
      folderId: selected.id,
      id: crypto.randomUUID(),
    })
    setOpening(false)
    if (result.ok) onWorkspaceReady(result.value)
    else setError(result.error)
  }

  return (
    <Modal title={t('startScreen.teamDialogTitle')} closeAriaLabel={t('startScreen.teamDialogClose')} onClose={onClose} className="start-screen-team-dialog">
      <div className="start-screen-team-body">
        <p className="start-screen-team-hint">{t('startScreen.teamDialogHint')}</p>
        {accounts.length > 1 && (
          <Field label={t('vc.link.account')}>
            {(id) => (
              <Select
                id={id}
                value={accountId}
                onChange={(event) => {
                  setAccountId(event.target.value)
                  setSelected(null)
                }}
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>{account.username}</option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <TeamWorkspacePicker accountId={accountId} selected={selected} onSelect={setSelected} allowCreate={false} />
        {error && <InlineAlert>{gitlabErrorMessage(error, t)}</InlineAlert>}
        <div className="start-screen-team-actions">
          <Button variant="ghost" onClick={onClose} disabled={opening}>{t('gitlab.cancel')}</Button>
          <Button disabled={selected === null} isLoading={opening} onClick={() => void open()}>
            {t('startScreen.teamDialogOpen')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
