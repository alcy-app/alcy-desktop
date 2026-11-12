import { useState } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { useSyncSensitiveValues } from '../../shared/security/sensitive-sync'
import { Button } from '../../shared/ui/Button'
import { Checkbox } from '../../shared/ui/Checkbox'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import type { LinkParams } from './use-version-control'

interface GitLinkFormProps {
  busy: boolean
  error: string | null
  onSubmit: (params: LinkParams) => void
}

/** A workspace without git: starting the repository, with the environments
 * versioned unless the person unchecks them. Sensitive values stay local
 * unless their protection is off in the settings, and the hint says which. */
export function GitLinkForm({ busy, error, onSubmit }: GitLinkFormProps) {
  const { t } = useLanguage()
  const [includeEnvironments, setIncludeEnvironments] = useState(true)
  const syncSensitiveValues = useSyncSensitiveValues()

  return (
    <div className="vc-link-form">
      <p className="vc-muted">{t('vc.git.initDescription')}</p>
      <label className="vc-checkbox-row">
        <Checkbox
          checked={includeEnvironments}
          disabled={busy}
          onChange={(event) => setIncludeEnvironments(event.target.checked)}
        />
        <span>
          {t('vc.git.initVersionEnvironments')}
          <span className="vc-muted vc-checkbox-hint">{t(syncSensitiveValues ? 'vc.git.initVersionEnvironmentsPlainHint' : 'vc.git.initVersionEnvironmentsHint')}</span>
        </span>
      </label>
      {error && <InlineAlert>{error}</InlineAlert>}
      <Button className="vc-primary-action" disabled={busy} isLoading={busy} onClick={() => onSubmit({ includeEnvironments })}>
        {t('vc.git.init')}
      </Button>
    </div>
  )
}
