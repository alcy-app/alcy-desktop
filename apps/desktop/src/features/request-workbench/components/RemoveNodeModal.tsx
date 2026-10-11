import { useId, useState } from 'react'
import { truncateMiddle } from '../../../shared/truncate-middle'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog'
import { Field } from '../../../shared/ui/Field'
import { Input } from '../../../shared/ui/Input'
import { Modal } from '../../../shared/ui/Modal'
import './remove-node-modal.css'

interface RemoveNodeModalProps {
  kind: 'collection' | 'folder' | 'request'
  name: string
  folderCount?: number
  requestCount?: number
  title?: string
  description?: string
  onRemove: () => void
  onCancel: () => void
}

export function RemoveNodeModal({
  kind,
  name,
  folderCount = 0,
  requestCount = 0,
  title,
  description,
  onRemove,
  onCancel,
}: RemoveNodeModalProps) {
  const { t } = useLanguage()
  const inputId = useId()
  const [confirmation, setConfirmation] = useState('')

  if (kind === 'request') {
    return (
      <ConfirmDialog
        title={t('collections.removeRequestModalTitle')}
        description={t('collections.removeRequestModalDescription', { name: truncateMiddle(name) })}
        confirmLabel={t('common.remove')}
        cancelLabel={t('common.cancel')}
        closeAriaLabel={t('collections.closeModalAria')}
        onConfirm={onRemove}
        onCancel={onCancel}
      />
    )
  }

  if (kind === 'folder') {
    return (
      <ConfirmDialog
        title={t('collections.removeFolderModalTitle')}
        description={t('collections.removeFolderModalDescription', {
          name: truncateMiddle(name),
          folders: folderCount,
          requests: requestCount,
        })}
        confirmLabel={t('common.remove')}
        cancelLabel={t('common.cancel')}
        closeAriaLabel={t('collections.closeModalAria')}
        onConfirm={onRemove}
        onCancel={onCancel}
      />
    )
  }

  const confirmed = confirmation === 'delete'
  const confirm = () => {
    if (confirmed) onRemove()
  }

  return (
    <Modal
      title={title ?? t('collections.removeCollectionModalTitle', { name: truncateMiddle(name) })}
      closeAriaLabel={t('collections.closeModalAria')}
      onClose={onCancel}
      onEnter={confirm}
      className="ui-modal--form ui-modal--md remove-collection-modal"
    >
      {(requestClose) => (
        <>
          <p className="ui-modal-description">
            {description ?? t('collections.removeCollectionModalDescription', { folders: folderCount, requests: requestCount })}
          </p>
          <Field label={t('collections.removeCollectionConfirmationLabel')} htmlFor={inputId}>
            <Input id={inputId} autoFocus mono value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
          </Field>
          <div className="ui-modal-actions">
            <Button variant="ghost" onClick={requestClose}>{t('common.cancel')}</Button>
            <Button variant="danger" disabled={!confirmed} onClick={confirm}>{t('collections.removeCollectionAction')}</Button>
          </div>
        </>
      )}
    </Modal>
  )
}
