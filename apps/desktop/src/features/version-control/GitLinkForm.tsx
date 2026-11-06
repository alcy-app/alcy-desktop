import { useState } from 'react'
import { pickWorkspaceFolder } from '../../bindings/pick-workspace-folder'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Checkbox } from '../../shared/ui/Checkbox'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { FolderIcon } from '../../shared/ui/icons'
import type { LinkParams } from './use-version-control'

interface GitLinkFormProps {
  busy: boolean
  error: string | null
  onSubmit: (params: LinkParams) => void
  onCancelBusy: () => void
}

/**
 * Git in the workspace folder, always starting on `main`: either a new
 * history, or joining a shared folder someone already publishes to (the
 * first sync brings their work into this workspace).
 */
export function GitLinkForm({ busy, error, onSubmit, onCancelBusy }: GitLinkFormProps) {
  const { t } = useLanguage()
  const [includeEnvironments, setIncludeEnvironments] = useState(false)

  const join = async () => {
    const sharedFolder = await pickWorkspaceFolder()
    if (sharedFolder !== null) onSubmit({ provider: 'git', sharedFolder, includeEnvironments })
  }

  return (
    <div className="vc-link-form">
      <h3 className="vc-section-title">{t('vc.git.initTitle')}</h3>

      <section className="vc-git-start">
        <h4>{t('vc.git.startNew')}</h4>
        <p className="vc-muted">{t('vc.git.startNewDescription')}</p>
        <Button disabled={busy} isLoading={busy} onClick={() => onSubmit({ provider: 'git', includeEnvironments })}>
          {t('vc.git.init')}
        </Button>
      </section>

      <section className="vc-git-start">
        <h4>{t('vc.git.join')}</h4>
        <p className="vc-muted">{t('vc.git.joinDescription')}</p>
        <Button variant="ghost" disabled={busy} onClick={() => void join()}>
          <FolderIcon size={13} />{t('vc.git.joinButton')}
        </Button>
      </section>

      <label className="vc-checkbox-row">
        <Checkbox checked={includeEnvironments} onChange={(event) => setIncludeEnvironments(event.target.checked)} />
        <span>
          {t('vc.link.includeEnvironments')}
          <span className="vc-muted vc-checkbox-hint">{t('vc.link.includeEnvironmentsHint')}</span>
        </span>
      </label>

      {error && <InlineAlert>{error}</InlineAlert>}

      {busy && (
        <div className="vc-actions">
          <Button variant="ghost" onClick={onCancelBusy}>
            {t('gitlab.cancel')}
          </Button>
        </div>
      )}
    </div>
  )
}
