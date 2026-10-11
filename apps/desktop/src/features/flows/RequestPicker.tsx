import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useLanguage } from '../../shared/i18n/use-language'
import { ChevronLeftIcon, FolderIcon, SearchIcon, SendIcon } from '../../shared/ui/icons'
import { useTooltip } from '../../shared/ui/use-tooltip'
import type { RequestSummary, TreeNode } from '../request-workbench/collection-tree'

const PICKER_WIDTH_PX = 280
const PICKER_MAX_HEIGHT_PX = 360
const VIEWPORT_MARGIN_PX = 8
const GAP_PX = 6

interface RequestPickerProps {
  /** Retângulo do gatilho que abriu o seletor (botão "Escolher requisição" do node) — usado para ancorar o popover. */
  anchor: DOMRect
  collections: TreeNode[]
  onClose: () => void
  onSelectRequest: (request: RequestSummary) => void
}

type PickerEntry = { kind: 'folder'; node: TreeNode } | { kind: 'request'; request: RequestSummary }

function methodLabel(request: RequestSummary): string {
  if (request.protocol === 'graphql') return 'GraphQL'
  return request.content.method.toUpperCase()
}

/** Seletor navegável (coleção → pastas → requisição) ancorado no
 * `RequestNode` que disparou a abertura — mesmo padrão de portal/ancoragem
 * de `BlockPalette`, duplicado propositalmente em vez de extraído
 * (convenção já seguida por `TemplateHighlightedField`). `path` é a pilha de
 * nodes percorridos (coleção, depois pastas); cada nível mostra suas
 * subpastas e suas requisições diretas, como no explorador de coleções —
 * substitui a antiga lista achatada de todas as requisições do workspace na
 * paleta de blocos. */
export function RequestPicker({ anchor, collections, onClose, onSelectRequest }: RequestPickerProps) {
  const { t } = useLanguage()
  const backTooltip = useTooltip(t('flows.canvas.requestPickerBackAria'))
  const [path, setPath] = useState<TreeNode[]>([])
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const currentNode = path[path.length - 1] ?? null

  useEffect(() => {
    inputRef.current?.focus()
  }, [currentNode])

  useEffect(() => {
    // Fase de captura (não bubble, como `BlockPalette`) — o canvas do xyflow
    // (pan/zoom, drag de node) pode interceptar e parar a propagação de
    // pointerdown/mousedown antes de chegar ao listener no `document` em
    // fase de bubble, o que deixava o popover aberto ao clicar no canvas.
    // Capturar primeiro garante que este listener roda antes de qualquer
    // `stopPropagation` do próprio xyflow.
    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [onClose])

  const needle = query.trim().toLowerCase()

  const filteredFolders = useMemo(() => {
    const folders = currentNode ? currentNode.folders : collections
    return folders.filter((folder) => !needle || folder.name.toLowerCase().includes(needle))
  }, [currentNode, collections, needle])

  const filteredRequests = useMemo(() => {
    const requests = currentNode ? currentNode.requests : []
    return requests.filter((request) => {
      if (!needle) return true
      const name = (request.name || '').toLowerCase()
      const url = request.content.endpointUrl.toLowerCase()
      const method = methodLabel(request).toLowerCase()
      return name.includes(needle) || url.includes(needle) || method.includes(needle)
    })
  }, [currentNode, needle])

  const entries = useMemo<PickerEntry[]>(
    () => [
      ...filteredFolders.map((node): PickerEntry => ({ kind: 'folder', node })),
      ...filteredRequests.map((request): PickerEntry => ({ kind: 'request', request })),
    ],
    [filteredFolders, filteredRequests],
  )

  const openFolder = (node: TreeNode) => {
    setPath((current) => [...current, node])
    setQuery('')
    setHighlightedIndex(0)
  }

  const goBack = () => {
    setPath((current) => current.slice(0, -1))
    setQuery('')
    setHighlightedIndex(0)
  }

  const selectEntry = (entry: PickerEntry) => {
    if (entry.kind === 'folder') {
      openFolder(entry.node)
    } else {
      onSelectRequest(entry.request)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlightedIndex((current) => Math.min(current + 1, entries.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlightedIndex((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const entry = entries[highlightedIndex]
      if (entry) selectEntry(entry)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      if (currentNode) {
        goBack()
      } else {
        onClose()
      }
    }
  }

  const left = Math.min(Math.max(anchor.left, VIEWPORT_MARGIN_PX), window.innerWidth - PICKER_WIDTH_PX - VIEWPORT_MARGIN_PX)
  const top = Math.min(anchor.bottom + GAP_PX, window.innerHeight - PICKER_MAX_HEIGHT_PX - VIEWPORT_MARGIN_PX)

  const breadcrumb = path.map((node) => node.name).join(' / ')

  return createPortal(
    <div
      ref={containerRef}
      className="flow-block-palette"
      style={{ left: Math.max(left, VIEWPORT_MARGIN_PX), top: Math.max(top, VIEWPORT_MARGIN_PX) }}
      role="listbox"
      aria-label={t('flows.canvas.requestPickerMenuLabel')}
      onKeyDown={handleKeyDown}
    >
      {currentNode && (
        <div className="flow-request-picker-header">
          <button
            type="button"
            className="flow-request-picker-back"
            aria-label={t('flows.canvas.requestPickerBackAria')}
            {...backTooltip.triggerProps}
            onClick={goBack}
          >
            <ChevronLeftIcon size={12} />
          </button>
          {backTooltip.tooltip}
          <span className="flow-request-picker-header-title" title={breadcrumb}>
            {breadcrumb}
          </span>
        </div>
      )}

      <div className="flow-block-palette-search">
        <SearchIcon size={12} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setHighlightedIndex(0)
          }}
          placeholder={
            currentNode ? t('flows.canvas.requestPickerLevelSearchPlaceholder') : t('flows.canvas.requestPickerCollectionSearchPlaceholder')
          }
          aria-label={
            currentNode ? t('flows.canvas.requestPickerLevelSearchAria') : t('flows.canvas.requestPickerCollectionSearchAria')
          }
        />
      </div>

      <div className="flow-block-palette-list">
        {filteredFolders.length > 0 && (
          <div className="flow-block-palette-group">
            <p className="flow-block-palette-group-label">
              {currentNode ? t('flows.canvas.requestPickerFoldersCategory') : t('flows.canvas.requestPickerCollectionsCategory')}
            </p>
            {filteredFolders.map((folder) => {
              const index = entries.findIndex((entry) => entry.kind === 'folder' && entry.node.id === folder.id)
              return (
                <button
                  key={folder.id}
                  type="button"
                  className={
                    index === highlightedIndex ? 'flow-block-palette-item flow-block-palette-item--active' : 'flow-block-palette-item'
                  }
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onClick={() => openFolder(folder)}
                >
                  <FolderIcon size={13} />
                  <span className="flow-block-palette-item-name">{folder.name}</span>
                </button>
              )
            })}
          </div>
        )}

        {filteredRequests.length > 0 && (
          <div className="flow-block-palette-group">
            {currentNode && <p className="flow-block-palette-group-label">{t('flows.canvas.paletteRequestsCategory')}</p>}
            {filteredRequests.map((request) => {
              const index = entries.findIndex((entry) => entry.kind === 'request' && entry.request.id === request.id)
              return (
                <button
                  key={request.id}
                  type="button"
                  className={
                    index === highlightedIndex ? 'flow-block-palette-item flow-block-palette-item--active' : 'flow-block-palette-item'
                  }
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onClick={() => onSelectRequest(request)}
                >
                  <SendIcon size={13} />
                  <span className="flow-block-palette-item-name">{request.name || t('common.unnamed')}</span>
                  <span className="flow-block-palette-item-method">{methodLabel(request)}</span>
                </button>
              )
            })}
          </div>
        )}

        {entries.length === 0 && (
          <p className="flow-block-palette-empty">
            {currentNode ? t('flows.canvas.requestPickerLevelEmptyState') : t('flows.canvas.requestPickerCollectionsEmptyState')}
          </p>
        )}
      </div>
    </div>,
    document.body,
  )
}
