import { useLanguage } from '../../../shared/i18n/use-language'
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog'

interface DiscardTabModalProps {
  description: string
  onDiscard: () => void
  onCancel: () => void
}

export function DiscardTabModal({ description, onDiscard, onCancel }: DiscardTabModalProps) {
  const { t } = useLanguage()

  return (
    <ConfirmDialog
      title={t('workbench.openTabs.discardModalTitle')}
      description={description}
      confirmLabel={t('workbench.openTabs.discardButton')}
      cancelLabel={t('common.cancel')}
      closeAriaLabel={t('collections.closeModalAria')}
      onConfirm={onDiscard}
      onCancel={onCancel}
    />
  )
}
