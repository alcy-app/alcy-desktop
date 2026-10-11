import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { TranslationKey } from '../../shared/i18n/translations'
import { useLanguage } from '../../shared/i18n/use-language'
import { SearchIcon } from '../../shared/ui/icons'
import type { FlowExecutionKindState, LoadNodeKindState, SimpleNodeKind } from './flows.types'
import { NODE_KIND_APPEARANCE } from './node-kind-appearance'
import { EXECUTABLE_LOAD_NODE_KINDS, LOAD_NODE_DEFINITIONS } from './load-node-config'

const PALETTE_WIDTH_PX = 340
const PALETTE_MAX_HEIGHT_PX = 440
const VIEWPORT_MARGIN_PX = 8
const GAP_PX = 6

/** O node `block` não é mais criado pela paleta — só continua existindo nos flows antigos que já o têm. */
export type PaletteKind = 'if' | 'request' | SimpleNodeKind | LoadNodeKindState

type PaletteCategory = 'blocks' | 'output' | 'requests' | 'mock' | 'annotation' | 'load'

interface PaletteItem {
  kind: PaletteKind
  category: PaletteCategory
}

const CATEGORIES: { id: PaletteCategory; labelKey: TranslationKey }[] = [
  { id: 'blocks', labelKey: 'flows.canvas.paletteBlocksCategory' },
  { id: 'output', labelKey: 'flows.canvas.paletteOutputCategory' },
  { id: 'requests', labelKey: 'flows.canvas.paletteRequestsCategory' },
  { id: 'mock', labelKey: 'flows.canvas.paletteMockCategory' },
  { id: 'annotation', labelKey: 'flows.canvas.paletteAnnotationCategory' },
  { id: 'load', labelKey: 'flows.canvas.paletteLoadCategory' },
]

/** Na ordem das categorias — é também a ordem de navegação pelo teclado.
 * Ícone, cor, nome e descrição vêm de `NODE_KIND_APPEARANCE`, os mesmos do
 * cartão do node. */
const PALETTE_ITEMS: PaletteItem[] = [
  { kind: 'if', category: 'blocks' },
  { kind: 'while', category: 'blocks' },
  { kind: 'break', category: 'blocks' },
  { kind: 'continue', category: 'blocks' },
  { kind: 'sleep', category: 'blocks' },
  { kind: 'setVariables', category: 'blocks' },
  { kind: 'log', category: 'output' },
  { kind: 'display', category: 'output' },
  { kind: 'request', category: 'requests' },
  { kind: 'inlineRequest', category: 'requests' },
  { kind: 'mockStart', category: 'mock' },
  { kind: 'mockWaitRequest', category: 'mock' },
  { kind: 'mockSetResponse', category: 'mock' },
  { kind: 'mockAssertCalls', category: 'mock' },
  { kind: 'mockStop', category: 'mock' },
  { kind: 'note', category: 'annotation' },
]

interface BlockPaletteProps {
  /** Retângulo do elemento que disparou a paleta (botão da toolbar ou "+" de um handle) — usado para ancorar o popover. */
  anchor: DOMRect
  executionKind: FlowExecutionKindState
  onClose: () => void
  onSelect: (kind: PaletteKind) => void
}

/** Seletor de blocos pesquisável e categorizado, renderizado num portal
 * (mesmo padrão de `Modal`/tooltip de `TemplateHighlightedField`) e ancorado
 * perto do gatilho, não centralizado na tela. A categoria "Requisições" tem
 * um único item ("Requisição de API"): o node nasce não configurado e a
 * escolha de coleção/requisição específica acontece dentro dele
 * (`RequestPicker`), não mais nesta lista achatada de todas as requisições
 * do workspace. */
export function BlockPalette({ anchor, executionKind, onClose, onSelect }: BlockPaletteProps) {
  const { t } = useLanguage()
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    // Fase de captura: o canvas (pan/zoom do xyflow) interrompe a propagação
    // do mousedown no pane, então um listener em bubble nunca veria o clique
    // fora. O botão da toolbar e os cliques no vazio do canvas (atalho do
    // menu e fechamento, tratados em `FlowCanvas`) fazem o próprio toggle,
    // por isso são ignorados aqui — fechar já no mousedown faria o clique do
    // atalho reabrir a paleta em seguida.
    function onMouseDown(event: MouseEvent) {
      const target = event.target as Element
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        !target.closest('.flow-add-menu-button') &&
        !target.closest('.react-flow__pane')
      ) {
        onClose()
      }
    }
    document.addEventListener('mousedown', onMouseDown, true)
    return () => document.removeEventListener('mousedown', onMouseDown, true)
  }, [onClose])

  const needle = query.trim().toLowerCase()

  const items = useMemo(() => {
      const base = executionKind === 'load'
        ? EXECUTABLE_LOAD_NODE_KINDS.map((kind): PaletteItem => ({ kind, category: 'load' }))
        : PALETTE_ITEMS
      return base.filter((item) => {
        if (!needle) return true
        const appearance = item.category === 'load'
          ? LOAD_NODE_DEFINITIONS[item.kind as LoadNodeKindState]
          : NODE_KIND_APPEARANCE[item.kind as Exclude<PaletteKind, LoadNodeKindState>]
        const { labelKey, descriptionKey } = appearance
        return t(labelKey).toLowerCase().includes(needle) || t(descriptionKey).toLowerCase().includes(needle)
      })
    }, [executionKind, needle, t])

  const selectItem = (item: PaletteItem) => onSelect(item.kind)

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlightedIndex((current) => Math.min(current + 1, items.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlightedIndex((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const item = items[highlightedIndex]
      if (item) selectItem(item)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  const entries = items.map((item, index) => ({ item, index }))

  const left = Math.min(Math.max(anchor.left, VIEWPORT_MARGIN_PX), window.innerWidth - PALETTE_WIDTH_PX - VIEWPORT_MARGIN_PX)
  const top = Math.min(anchor.bottom + GAP_PX, window.innerHeight - PALETTE_MAX_HEIGHT_PX - VIEWPORT_MARGIN_PX)

  return createPortal(
    <div
      ref={containerRef}
      className="flow-block-palette"
      style={{
        left: Math.max(left, VIEWPORT_MARGIN_PX),
        top: Math.max(top, VIEWPORT_MARGIN_PX),
        width: PALETTE_WIDTH_PX,
        maxHeight: PALETTE_MAX_HEIGHT_PX,
      }}
      role="listbox"
      aria-label={t('flows.canvas.addBlocksMenuLabel')}
      onKeyDown={handleKeyDown}
    >
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
          placeholder={t('flows.canvas.paletteSearchPlaceholder')}
          aria-label={t('flows.canvas.paletteSearchAria')}
        />
      </div>

      <div className="flow-block-palette-list">
        {CATEGORIES.map((category) => {
          const categoryEntries = entries.filter((entry) => entry.item.category === category.id)
          if (categoryEntries.length === 0) return null
          return (
            <div key={category.id} className="flow-block-palette-group">
              <p className="flow-block-palette-group-label">{t(category.labelKey)}</p>
              {categoryEntries.map(({ item, index }) => {
                const load = item.category === 'load'
                const appearance = load ? LOAD_NODE_DEFINITIONS[item.kind as LoadNodeKindState] : NODE_KIND_APPEARANCE[item.kind as Exclude<PaletteKind, LoadNodeKindState>]
                const { Icon, tone } = NODE_KIND_APPEARANCE[load ? 'load' : item.kind as Exclude<PaletteKind, LoadNodeKindState>]
                const { labelKey, descriptionKey } = appearance
                return (
                  <button
                    key={item.kind}
                    type="button"
                    className={`flow-block-palette-item flow-block-palette-item--block flow-node--tone-${tone}${index === highlightedIndex ? ' flow-block-palette-item--active' : ''}`}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => selectItem(item)}
                  >
                    <span className="flow-block-palette-item-icon" aria-hidden="true">
                      <Icon size={14} />
                    </span>
                    <span className="flow-block-palette-item-text">
                      <span className="flow-block-palette-item-name">{t(labelKey)}</span>
                      <span className="flow-block-palette-item-description">{t(descriptionKey)}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          )
        })}

        {items.length === 0 && <p className="flow-block-palette-empty">{t('flows.canvas.paletteEmptyState')}</p>}
      </div>
    </div>,
    document.body,
  )
}
