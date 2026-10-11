import { useEffect, useId, useRef, useState } from 'react'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { Field } from '../../../shared/ui/Field'
import { Input } from '../../../shared/ui/Input'
import { Modal } from '../../../shared/ui/Modal'
import type { TreeNode } from '../collection-tree'
import { useDestinationBrowser } from '../use-destination-browser'
import { DestinationBrowser, DestinationNewNodeButton } from './DestinationBrowser'

interface SaveRequestModalProps {
  collections: TreeNode[]
  /** Nome atual da aba — vem preenchido e selecionado no campo de nome. */
  initialName: string
  onSave: (parentId: string, name: string) => void
  /** Cria uma collection com o nome dado e devolve o id dela. */
  onCreateCollection: (name: string) => string
  /** Cria uma pasta com o nome dado dentro de `parentId` e devolve o id dela. */
  onCreateFolder: (parentId: string, name: string) => string
  onClose: () => void
}

/** Salvar uma requisição em rascunho: nome + destino escolhido navegando em
 * níveis (collection → subpastas). O destino é o nível em que o usuário está;
 * na raiz ainda não há destino e "Salvar" fica desabilitado. O botão do rodapé
 * cria uma collection na raiz ou uma pasta dentro do nível atual. */
export function SaveRequestModal({
  collections,
  initialName,
  onSave,
  onCreateCollection,
  onCreateFolder,
  onClose,
}: SaveRequestModalProps) {
  const { t } = useLanguage()
  const [name, setName] = useState(initialName)
  const browser = useDestinationBrowser({ collections, onCreateCollection, onCreateFolder })
  const fieldId = useId()
  const nameInputRef = useRef<HTMLInputElement>(null)

  const { currentNode } = browser
  const trimmedName = name.trim()
  const canSave = trimmedName.length > 0 && currentNode !== null

  useEffect(() => {
    nameInputRef.current?.select()
  }, [])

  const submit = () => {
    if (!canSave || !currentNode) return
    onSave(currentNode.id, trimmedName)
  }

  return (
    <Modal
      title={t('collections.saveRequestModalTitle')}
      closeAriaLabel={t('collections.closeModalAria')}
      onClose={onClose}
      onEscape={browser.creatingNode ? browser.cancelNewNode : undefined}
      onEnter={submit}
      className="ui-modal--form destination-modal"
    >
      {(requestClose) => (
        <>
          <Field label={t('collections.saveRequestNameLabel')} htmlFor={`${fieldId}-name`}>
            <Input
              ref={nameInputRef}
              id={`${fieldId}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <DestinationBrowser browser={browser} label={t('collections.saveToLabel')} />

          <div className="ui-modal-actions">
            <DestinationNewNodeButton browser={browser} />
            <Button variant="ghost" onClick={requestClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={submit} disabled={!canSave}>
              {t('collections.saveRequestButton')}
            </Button>
          </div>
        </>
      )}
    </Modal>
  )
}
