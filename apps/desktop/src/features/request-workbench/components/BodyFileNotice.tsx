import { useLanguage } from '../../../shared/i18n/use-language'
import { AlertIcon } from '../../../shared/ui/icons'
import { isAbsolutePath } from '../body-state'

interface BodyFileNoticeProps {
  path: string
  missing: boolean
}

/** Aviso sobre o arquivo de um corpo: ausente nesta máquina (o envio vai
 * falhar) ou fora do workspace (o caminho absoluto fica salvo e pode não
 * existir em outras máquinas). Nada quando está tudo certo. */
export function BodyFileNotice({ path, missing }: BodyFileNoticeProps) {
  const { t } = useLanguage()
  if (missing) {
    return (
      <span className="rw-body-file-notice rw-body-file-notice--missing" title={t('requestBody.fileMissingTitle', { path })}>
        <AlertIcon size={12} />
        {t('requestBody.fileMissing')}
      </span>
    )
  }
  if (isAbsolutePath(path)) {
    return (
      <span className="rw-body-file-notice" title={t('requestBody.fileOutsideWorkspaceTitle')}>
        {t('requestBody.fileOutsideWorkspace')}
      </span>
    )
  }
  return null
}
