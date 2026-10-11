import { Button } from './Button'
import { Modal } from './Modal'

interface ConfirmDialogProps {
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  closeAriaLabel: string
  onConfirm: () => void
  onCancel: () => void
  /** `danger` para ações destrutivas (padrão); `primary` para confirmações neutras. */
  tone?: 'danger' | 'primary'
}

/** Modal de confirmação padrão: descrição + Cancelar/Confirmar, sobre `Modal`.
 * Enter confirma e Esc cancela; com o foco num dos botões, o Enter ativa esse botão. */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  closeAriaLabel,
  onConfirm,
  onCancel,
  tone = 'danger',
}: ConfirmDialogProps) {
  return (
    <Modal title={title} closeAriaLabel={closeAriaLabel} onClose={onCancel} onEnter={onConfirm} className="ui-modal--form">
      {(requestClose) => (
        <>
          <p className="ui-modal-description">{description}</p>
          <div className="ui-modal-actions">
            <Button variant="ghost" onClick={requestClose}>
              {cancelLabel}
            </Button>
            <Button variant={tone} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </>
      )}
    </Modal>
  )
}
