import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { IconButton } from '../../../shared/ui/IconButton'
import { CloseIcon, FolderIcon } from '../../../shared/ui/icons'
import { fileNameOf } from '../body-state'
import { BodyFileNotice } from './BodyFileNotice'

interface BinaryBodyPanelProps {
  filePath: string
  onChange: (filePath: string) => void
  onPickFile: () => Promise<string | null>
  /** `true` quando o arquivo escolhido não existe nesta máquina. */
  missing: boolean
}

/** Corpo "binary": um único arquivo enviado como está. Só o caminho fica
 * na aba — os bytes são lidos pelo backend no momento do envio. */
export function BinaryBodyPanel({ filePath, onChange, onPickFile, missing }: BinaryBodyPanelProps) {
  const { t } = useLanguage()

  const pick = async () => {
    const path = await onPickFile()
    if (path) onChange(path)
  }

  return (
    <div className="rw-body-binary">
      <div className={missing ? 'rw-body-binary-card rw-body-binary-card--missing' : 'rw-body-binary-card'}>
        <span className="rw-body-binary-icon" aria-hidden="true">
          <FolderIcon size={18} />
        </span>
        {filePath ? (
          <div className="rw-body-binary-file">
            <span className="rw-body-binary-name">{fileNameOf(filePath)}</span>
            <span className="rw-body-binary-path" title={filePath}>
              {filePath}
            </span>
            <BodyFileNotice path={filePath} missing={missing} />
          </div>
        ) : (
          <div className="rw-body-binary-file">
            <span className="rw-body-binary-name rw-body-binary-name--empty">{t('requestBody.binaryEmptyTitle')}</span>
            <span className="rw-body-binary-path">{t('requestBody.binaryHint')}</span>
          </div>
        )}
        <div className="rw-body-binary-actions">
          <Button variant="ghost" onClick={() => void pick()}>
            {filePath ? t('requestBody.changeFile') : t('requestBody.chooseFile')}
          </Button>
          {filePath && (
            <IconButton
              icon={<CloseIcon size={12} />}
              label={t('requestBody.clearFileAria', { name: fileNameOf(filePath) })}
              onClick={() => onChange('')}
            />
          )}
        </div>
      </div>
    </div>
  )
}
