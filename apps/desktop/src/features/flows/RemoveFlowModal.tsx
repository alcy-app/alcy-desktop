import { truncateMiddle } from '../../shared/truncate-middle'
import { useLanguage } from '../../shared/i18n/use-language'
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog'

interface RemoveFlowModalProps {
  name: string
  onRemove: () => void
  onCancel: () => void
}

export function RemoveFlowModal({ name, onRemove, onCancel }: RemoveFlowModalProps) {
  const { t } = useLanguage()

  return (
    <ConfirmDialog
      title={t('flows.removeModalTitle')}
      description={t('flows.removeModalDescription', { name: truncateMiddle(name) })}
      confirmLabel={t('common.remove')}
      cancelLabel={t('common.cancel')}
      closeAriaLabel={t('collections.closeModalAria')}
      onConfirm={onRemove}
      onCancel={onCancel}
    />
  )
}
