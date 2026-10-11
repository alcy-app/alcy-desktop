import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { Modal } from '../../../shared/ui/Modal'
import type { TreeNode } from '../collection-tree'
import { useDestinationBrowser } from '../use-destination-browser'
import { DestinationBrowser, DestinationNewNodeButton } from './DestinationBrowser'

interface MoveRequestModalProps {
  collections: TreeNode[]
  /** Pastas que não podem ser destino (no lote: as pastas selecionadas e suas subpastas). */
  excludedIds?: ReadonlySet<string>
  /** Título no lugar do padrão de uma requisição (ex.: "Mover 3 itens"). */
  title?: string
  onMove: (targetParentId: string) => void
  /** Cria uma collection com o nome dado e devolve o id dela. */
  onCreateCollection: (name: string) => string
  /** Cria uma pasta com o nome dado dentro de `parentId` e devolve o id dela. */
  onCreateFolder: (parentId: string, name: string) => string
  onClose: () => void
}

/** Mover requisições/pastas com o mesmo navegador de destino do modal de salvar:
 * o destino é o nível em que o usuário está; na raiz "Mover" fica desabilitado. */
export function MoveRequestModal({
  collections,
  excludedIds,
  title,
  onMove,
  onCreateCollection,
  onCreateFolder,
  onClose,
}: MoveRequestModalProps) {
  const { t } = useLanguage()
  const browser = useDestinationBrowser({ collections, excludedIds, onCreateCollection, onCreateFolder })
  const { currentNode } = browser

  const submit = () => {
    if (!currentNode) return
    onMove(currentNode.id)
  }

  return (
    <Modal
      title={title ?? t('collections.moveRequestModalTitle')}
      closeAriaLabel={t('collections.closeModalAria')}
      onClose={onClose}
      onEscape={browser.creatingNode ? browser.cancelNewNode : undefined}
      onEnter={submit}
      className="ui-modal--form destination-modal"
    >
      {(requestClose) => (
        <>
          <DestinationBrowser browser={browser} label={t('collections.moveToLabel')} />

          <div className="ui-modal-actions">
            <DestinationNewNodeButton browser={browser} />
            <Button variant="ghost" onClick={requestClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={submit} disabled={currentNode === null}>
              {t('collections.moveRequestButton')}
            </Button>
          </div>
        </>
      )}
    </Modal>
  )
}
