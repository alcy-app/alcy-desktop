import type { BodyFileStatus } from '../../../bindings/check-body-files'
import { useLanguage } from '../../../shared/i18n/use-language'
import { AlertIcon } from '../../../shared/ui/icons'

interface BodyFileNoticeProps {
  path: string
  /** From the backend; `undefined` while it is being checked. */
  status: BodyFileStatus | undefined
  /** Opens the file dialog again, offered when the file is blocked. */
  onPick: () => void
}

/** Notice next to a body file: missing on this machine (the send fails),
 * blocked (outside the workspace and not picked here, spec 0163), or outside
 * the workspace but readable (the absolute path is saved and may not exist
 * on other machines). Nothing when all is well. */
export function BodyFileNotice({ path, status, onPick }: BodyFileNoticeProps) {
  const { t } = useLanguage()
  if (status === 'missing') {
    return (
      <span className="rw-body-file-notice rw-body-file-notice--missing" title={t('requestBody.fileMissingTitle', { path })}>
        <AlertIcon size={12} />
        {t('requestBody.fileMissing')}
      </span>
    )
  }
  if (status === 'blocked') {
    return (
      <span className="rw-body-file-notice rw-body-file-notice--missing" title={t('requestBody.fileBlockedTitle', { path })}>
        <AlertIcon size={12} />
        {t('requestBody.fileBlocked')}
        <button type="button" className="rw-body-file-notice-action" onClick={onPick}>
          {t('requestBody.chooseFileAgain')}
        </button>
      </span>
    )
  }
  if (status === 'outsideAllowed') {
    return (
      <span className="rw-body-file-notice" title={t('requestBody.fileOutsideWorkspaceTitle')}>
        {t('requestBody.fileOutsideWorkspace')}
      </span>
    )
  }
  return null
}
