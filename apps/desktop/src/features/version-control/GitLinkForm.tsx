import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import type { LinkParams } from './use-version-control'

interface GitLinkFormProps {
  busy: boolean
  error: string | null
  onSubmit: (params: LinkParams) => void
}

/** A workspace without git: one action, starting the repository. */
export function GitLinkForm({ busy, error, onSubmit }: GitLinkFormProps) {
  const { t } = useLanguage()

  return (
    <div className="vc-link-form">
      <p className="vc-muted">{t('vc.git.initDescription')}</p>
      {error && <InlineAlert>{error}</InlineAlert>}
      <Button className="vc-primary-action" disabled={busy} isLoading={busy} onClick={() => onSubmit({ includeEnvironments: false })}>
        {t('vc.git.init')}
      </Button>
    </div>
  )
}
