import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { IconButton } from '../../../shared/ui/IconButton'
import { ChevronLeftIcon, ChevronRightIcon, FolderIcon, SearchIcon } from '../../../shared/ui/icons'
import type { DestinationBrowserState } from '../use-destination-browser'
import { RequestMethodBadge } from './RequestMethodBadge'
import './destination-browser.css'

interface DestinationBrowserProps {
  browser: DestinationBrowserState
  /** Rótulo da linha do destino (ex.: "Salvar em", "Mover para"). */
  label: string
}

/** Linha do destino (voltar + caminho) e a lista navegável de collections/pastas,
 * com busca no nível atual. A lista tem altura própria e rola por dentro, então
 * muitas pastas ou requisições não empurram o modal para fora da tela. */
export function DestinationBrowser({ browser, label }: DestinationBrowserProps) {
  const { t } = useLanguage()
  const { path, currentNode, query, levelFolders, levelRequests, creatingNode, newNodeName } = browser
  const breadcrumb = path.map((node) => node.name).join(' / ')

  const emptyLabel = browser.searching
    ? t('collections.saveDestinationSearchEmpty')
    : currentNode
      ? null
      : t('collections.destinationEmptyState')

  return (
    <>
      <div className="destination-browser-path">
        <span className="ui-field-label">{label}</span>
        {currentNode ? (
          <>
            <IconButton
              className="destination-browser-back"
              icon={<ChevronLeftIcon size={12} />}
              label={t('collections.saveDestinationBackAria')}
              onClick={browser.goBack}
            />
            <span className="destination-browser-breadcrumb" title={breadcrumb}>
              {breadcrumb}
            </span>
          </>
        ) : (
          <span className="destination-browser-placeholder">{t('collections.saveToPlaceholder')}</span>
        )}
      </div>

      <div className="destination-browser">
        <div className="destination-browser-search">
          <SearchIcon size={12} />
          <input
            type="text"
            value={query}
            onChange={(event) => browser.setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Backspace' && query === '' && currentNode) browser.goBack()
            }}
            placeholder={t('collections.saveDestinationSearchPlaceholder')}
            aria-label={t('collections.saveDestinationSearchPlaceholder')}
          />
        </div>

        <ul className="destination-browser-list" aria-label={t('collections.saveDestinationListAria')}>
          {creatingNode && (
            <li className="destination-browser-row destination-browser-row--new">
              <FolderIcon size={13} />
              <input
                autoFocus
                className="destination-browser-new-input"
                value={newNodeName}
                placeholder={t(currentNode ? 'collections.newFolderName' : 'collections.newCollectionName')}
                aria-label={t(currentNode ? 'collections.saveNewFolderNameAria' : 'collections.saveNewCollectionNameAria')}
                onChange={(event) => browser.setNewNodeName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    browser.createNode()
                  }
                }}
                onBlur={() => {
                  if (!newNodeName.trim()) browser.cancelNewNode()
                }}
              />
            </li>
          )}

          {levelFolders.map((folder) => (
            <li key={folder.id}>
              <button
                type="button"
                className="destination-browser-row destination-browser-row--folder"
                onClick={() => browser.enter(folder.id)}
              >
                <FolderIcon size={13} />
                <span className="destination-browser-row-name">{folder.name}</span>
                {folder.folders.length > 0 && <ChevronRightIcon size={10} className="destination-browser-row-chevron" />}
              </button>
            </li>
          ))}

          {levelRequests.map((request) => (
            <li key={request.id} className="destination-browser-row destination-browser-row--request" aria-disabled="true">
              <RequestMethodBadge
                protocol={request.protocol}
                method={request.content.method}
                className="destination-browser-method"
              />
              <span className="destination-browser-row-name">{request.name}</span>
            </li>
          ))}

          {levelFolders.length === 0 && !creatingNode && emptyLabel && (
            <li className="destination-browser-empty">{emptyLabel}</li>
          )}
        </ul>
      </div>
    </>
  )
}

/** Botão do rodapé que cria uma collection na raiz ou uma pasta dentro do nível atual. */
export function DestinationNewNodeButton({ browser }: { browser: DestinationBrowserState }) {
  const { t } = useLanguage()
  return (
    <Button
      variant="ghost"
      className="destination-browser-new-node"
      disabled={browser.creatingNode}
      onClick={browser.startNewNode}
    >
      {t(browser.currentNode ? 'collections.saveNewFolderButton' : 'collections.saveNewCollectionButton')}
    </Button>
  )
}
