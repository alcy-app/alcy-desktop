import { truncateMiddle } from '../../shared/truncate-middle'
import { useLanguage } from '../../shared/i18n/use-language'
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog'

interface RemoveEnvironmentModalProps {
  name: string
  onRemove: () => void
  onCancel: () => void
}

export function RemoveEnvironmentModal({ name, onRemove, onCancel }: RemoveEnvironmentModalProps) {
  const { t } = useLanguage()

  return (
    <ConfirmDialog
      title={t('environments.removeModalTitle')}
      description={t('environments.removeModalDescription', { name: truncateMiddle(name) })}
      confirmLabel={t('common.remove')}
      cancelLabel={t('common.cancel')}
      closeAriaLabel={t('collections.closeModalAria')}
      onConfirm={onRemove}
      onCancel={onCancel}
    />
  )
}
