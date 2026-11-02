import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useLanguage } from '../../../shared/i18n/use-language'
import { SearchIcon } from '../../../shared/ui/icons'
import type { RequestProtocol } from '../collection-tree'
import './new-request-popover.css'

const POPOVER_WIDTH_PX = 260
const POPOVER_MAX_HEIGHT_PX = 320
const VIEWPORT_MARGIN_PX = 8
const GAP_PX = 6

const REQUEST_TYPES: Array<{
  protocol: RequestProtocol
  label: string
  badge: string
  hintKey:
    | 'collections.protocolGraphqlHint'
    | 'collections.protocolRestHint'
    | 'collections.protocolGrpcHint'
    | 'collections.protocolWebSocketHint'
}> = [
  { protocol: 'rest', label: 'HTTP', badge: 'HTTP', hintKey: 'collections.protocolRestHint' },
  { protocol: 'graphql', label: 'GraphQL', badge: 'GQL', hintKey: 'collections.protocolGraphqlHint' },
  { protocol: 'grpc', label: 'gRPC', badge: 'gRPC', hintKey: 'collections.protocolGrpcHint' },
  { protocol: 'websocket', label: 'WebSocket', badge: 'WS', hintKey: 'collections.protocolWebSocketHint' },
]

interface NewRequestPopoverProps {
  /** Retângulo do botão que abriu o popover ("+" das abas, da sidebar ou "⋯" de uma pasta). */
  anchor: DOMRect
  onSelect: (protocol: RequestProtocol) => void
  /** Presente só quando aberto pelo "+" da sidebar: acrescenta "Criar Collection", separado dos tipos de requisição. */
  onCreateCollection?: () => void
  onClose: () => void
}

/** Popover com busca para escolher o tipo da nova requisição — mesmo padrão de
 * portal/ancoragem/teclado de `RequestPicker` (flows), duplicado em vez de
 * extraído porque o conteúdo e a navegação em níveis de lá não se aplicam aqui. */
export function NewRequestPopover({ anchor, onSelect, onCreateCollection, onClose }: NewRequestPopoverProps) {
  const { t } = useLanguage()
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [onClose])

  const needle = query.trim().toLowerCase()
  const options = useMemo(
    () => REQUEST_TYPES.filter((option) => !needle || option.label.toLowerCase().includes(needle)),
    [needle],
  )
  const createCollectionLabel = t('collections.createCollectionMenuItem')
  const showCreateCollection =
    onCreateCollection !== undefined && (!needle || createCollectionLabel.toLowerCase().includes(needle))
  // "Criar Collection" ocupa o último índice da navegação por teclado, depois dos tipos.
  const itemCount = options.length + (showCreateCollection ? 1 : 0)

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlightedIndex((current) => Math.min(current + 1, itemCount - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlightedIndex((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const option = options[highlightedIndex]
      if (option) onSelect(option.protocol)
      else if (showCreateCollection && highlightedIndex === options.length) onCreateCollection?.()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
  }

  const left = Math.min(anchor.left, window.innerWidth - POPOVER_WIDTH_PX - VIEWPORT_MARGIN_PX)
  const top = Math.min(anchor.bottom + GAP_PX, window.innerHeight - POPOVER_MAX_HEIGHT_PX - VIEWPORT_MARGIN_PX)

  return createPortal(
    <div
      ref={containerRef}
      className="new-request-popover"
      style={{ left: Math.max(left, VIEWPORT_MARGIN_PX), top: Math.max(top, VIEWPORT_MARGIN_PX) }}
      onKeyDown={handleKeyDown}
    >
      <div className="new-request-popover-search">
        <SearchIcon size={12} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setHighlightedIndex(0)
          }}
          placeholder={t('collections.newRequestSearchPlaceholder')}
          aria-label={t('collections.newRequestSearchAria')}
        />
      </div>

      <div className="new-request-popover-list" role="listbox" aria-label={t('collections.newRequestTypesAria')}>
        {options.map((option, index) => (
          <button
            key={option.protocol}
            type="button"
            role="option"
            aria-selected={index === highlightedIndex}
            className={
              index === highlightedIndex
                ? 'new-request-popover-item new-request-popover-item--active'
                : 'new-request-popover-item'
            }
            title={t(option.hintKey)}
            onMouseEnter={() => setHighlightedIndex(index)}
            onClick={() => onSelect(option.protocol)}
          >
            <span className={`new-request-popover-badge new-request-popover-badge--${option.protocol}`} aria-hidden="true">
              {option.badge}
            </span>
            <span className="new-request-popover-name">{option.label}</span>
          </button>
        ))}

        {showCreateCollection && (
          <>
            {options.length > 0 && <div className="new-request-popover-divider" role="separator" />}
            <button
              type="button"
              role="option"
              aria-selected={highlightedIndex === options.length}
              className={
                highlightedIndex === options.length
                  ? 'new-request-popover-item new-request-popover-item--active'
                  : 'new-request-popover-item'
              }
              onMouseEnter={() => setHighlightedIndex(options.length)}
              onClick={onCreateCollection}
            >
              <span className="new-request-popover-name">{createCollectionLabel}</span>
            </button>
          </>
        )}

        {itemCount === 0 && <p className="new-request-popover-empty">{t('collections.newRequestSearchEmpty')}</p>}
      </div>
    </div>,
    document.body,
  )
}
