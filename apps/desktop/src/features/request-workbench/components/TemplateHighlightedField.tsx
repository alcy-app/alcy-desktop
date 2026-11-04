import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, ChangeEvent, ClipboardEvent, FocusEvent, KeyboardEvent, MouseEvent, ReactNode, RefObject, UIEvent } from 'react'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import type { RouteParamEntry } from '../request-workbench.types'
import { useLanguage } from '../../../shared/i18n/use-language'
import { findRouteParamRanges } from '../query-params'
import type { FieldSuggestion } from '../schema-completions'
import { findOpenTemplateQuery, parseTemplate } from '../template-highlight'
import type { OpenTemplateQuery, VariableSegment } from '../template-highlight'
import { useVariableEditing } from '../variable-editing-context'
import { VariablePreviewCard } from './VariablePreviewCard'
import type { VariableDoc } from './VariablePreviewCard'
import './template-highlight.css'

interface TemplateHighlightedFieldProps {
  id: string
  value: string
  onChange: (value: string) => void
  variables: EnvironmentVariableDto[]
  fieldClassName: string
  placeholder?: string
  /** Campo sensível (senha, client secret): o texto digitado aparece como
   * pontos, as referências `{{variável}}` seguem visíveis — numa cor própria —
   * e o tooltip nunca revela o valor da variável. Copiar/recortar é bloqueado,
   * como num `<input type="password">`. */
  masked?: boolean
  /** Valores conhecidos para o campo inteiro (ex.: nomes e valores vindos da
   * documentação importada). A lista abre ao digitar, clicar ou com ↓ — nunca
   * só por receber foco, para que Tab na grid não aceite nada por engano. */
  suggestions?: FieldSuggestion[]
  /** `false` para campos que o backend não interpola (ex.: nome de header):
   * sem destaque nem sugestões de `{{variável}}`, só `suggestions`. */
  templates?: boolean
  /** Documentação de parâmetros de path, por nome de `{{variável}}`. */
  variableDocs?: Record<string, VariableDoc>
  /** Destaca tokens :nome presentes no caminho da URL. */
  highlightRouteParams?: boolean
  /** Valores de path variables; quando informado junto do callback, o token :nome exibe um cartão editável. */
  routeParams?: RouteParamEntry[]
  onUpdateRouteParamValue?: (id: string, value: string) => void
  /** Colar tratado pelo dono do campo (ex.: importar cURL na barra de endpoint);
   * `preventDefault()` no evento descarta o texto colado. */
  onPaste?: (event: ClipboardEvent<HTMLInputElement>) => void
  readOnly?: boolean
}

const TOOLTIP_GAP_PX = 6
const TOOLTIP_MAX_WIDTH_PX = 320
const VIEWPORT_MARGIN_PX = 8
const SUGGESTIONS_WIDTH_PX = 240
const SUGGESTIONS_MAX_ITEMS = 8
/** Tempo para o mouse cruzar o espaço entre o token e o cartão sem fechá-lo. */
const PREVIEW_CLOSE_DELAY_MS = 150

interface TooltipAnchor {
  left: number
  top: number
  bottom: number
}

/** Lado em que o cartão abre: acima do token por padrão, abaixo quando não há
 * altura suficiente acima (token perto do topo da janela). */
type TooltipPlacement = 'above' | 'below'

/**
 * Viewport x where the first `index` characters of the input's value end, as
 * the input draws them (font, padding, horizontal scroll) — measured with an
 * invisible probe in the input's font. Kept within the input's box. Without
 * layout (tests) the width is 0 and the result is the text start.
 */
function textEndLeft(input: HTMLInputElement, index: number): number {
  const rect = input.getBoundingClientRect()
  const style = getComputedStyle(input)
  const probe = document.createElement('span')
  probe.textContent = input.value.slice(0, index)
  Object.assign(probe.style, {
    position: 'fixed',
    visibility: 'hidden',
    whiteSpace: 'pre',
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    letterSpacing: style.letterSpacing,
  })
  document.body.appendChild(probe)
  const width = probe.getBoundingClientRect().width
  probe.remove()
  const textStart = rect.left + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.paddingLeft) || 0)
  return Math.min(Math.max(textStart + width - input.scrollLeft, rect.left), rect.right)
}

function anchorForToken(element: HTMLElement): TooltipAnchor {
  const rect = element.getBoundingClientRect()
  const left = Math.min(rect.left, window.innerWidth - TOOLTIP_MAX_WIDTH_PX - VIEWPORT_MARGIN_PX)
  return {
    left: Math.max(left, VIEWPORT_MARGIN_PX),
    top: rect.top,
    bottom: rect.bottom,
  }
}

/**
 * Posição do cartão na viewport, a partir do token sob o mouse. A altura do
 * cartão só é conhecida depois de montado (docs do parâmetro, aviso de
 * indefinida, campo de valor), então o lado é decidido num `useLayoutEffect`:
 * sem espaço acima, o cartão abre abaixo do token em vez de ser cortado pelo
 * topo da janela. O `ResizeObserver` reavalia quando o cartão cresce com ele
 * aberto (ex.: "Criar no ambiente ativo" adiciona o campo de valor).
 */
function useTooltipCard(cardRef: RefObject<HTMLDivElement | null>) {
  const [anchor, setAnchor] = useState<TooltipAnchor | null>(null)
  const [placement, setPlacement] = useState<TooltipPlacement>('above')

  const open = (element: HTMLElement) => {
    setAnchor(anchorForToken(element))
    setPlacement('above')
  }

  const close = () => setAnchor(null)

  /** O foco dentro do cartão (campo de valor) o mantém aberto. */
  const holdsFocus = () => cardRef.current?.contains(document.activeElement) ?? false

  useLayoutEffect(() => {
    const card = cardRef.current
    if (!anchor || !card) return

    const updatePlacement = () => {
      const spaceAbove = anchor.top - TOOLTIP_GAP_PX - VIEWPORT_MARGIN_PX
      const spaceBelow = window.innerHeight - anchor.bottom - TOOLTIP_GAP_PX - VIEWPORT_MARGIN_PX
      // Sem espaço dos dois lados, fica do lado com mais sobra.
      setPlacement(spaceAbove < card.offsetHeight && spaceBelow > spaceAbove ? 'below' : 'above')
    }

    updatePlacement()
    const observer = new ResizeObserver(updatePlacement)
    observer.observe(card)
    return () => observer.disconnect()
  }, [anchor, cardRef])

  const style: CSSProperties | undefined = anchor
    ? placement === 'above'
      ? { left: anchor.left, bottom: window.innerHeight - anchor.top + TOOLTIP_GAP_PX }
      : { left: anchor.left, top: anchor.bottom + TOOLTIP_GAP_PX }
    : undefined

  return { isOpen: anchor !== null, open, close, holdsFocus, style }
}

/** How the field tells a token that the pointer entered or left it (see
 * `setHoveredToken` in `TemplateHighlightedField`). */
interface TokenHoverHandlers {
  enter: (element: HTMLElement) => void
  leave: () => void
}

type RegisterTokenHover = (index: number, handlers: TokenHoverHandlers) => () => void

/** Editing state of a token in the field: the caret is inside it (`active`)
 * or the selection covers it (`selected`). */
interface TokenEditState {
  active: boolean
  selected: boolean
}

function tokenClassName(base: string, state: TokenEditState, hovered: boolean): string {
  let className = base
  if (state.selected) className += ' var-token--selected'
  else if (state.active) className += ' var-token--active'
  if (hovered) className += ' var-token--hovered'
  return className
}

/**
 * The preview card is rendered in a portal on `document.body`, positioned
 * `fixed` from the token's viewport position — not as a child of the field.
 * An `::after` inside the overlay would be clipped by any ancestor with
 * `overflow: hidden` (needed there to clip the field's text), including near
 * the window edges.
 *
 * The token does not receive pointer events: the `<input>` underneath needs
 * them to click, drag-select and double-click the variable name. The field
 * hit-tests the pointer against the tokens and notifies the token through
 * `registerHover`.
 *
 * The card is interactive (the variable value is editable in it): it stays
 * open while the pointer is over the token or over the card itself — with a
 * short grace period to cross the gap between them — or while focus is
 * inside it.
 */
function useTokenPreview(cardRef: RefObject<HTMLDivElement | null>, index: number, registerHover: RegisterTokenHover) {
  const card = useTooltipCard(cardRef)
  const closeTimerRef = useRef<number | null>(null)
  const cardHoveredRef = useRef(false)

  const cancelClose = () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }

  const scheduleClose = () => {
    cancelClose()
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      if (cardHoveredRef.current || card.holdsFocus()) return
      card.close()
    }, PREVIEW_CLOSE_DELAY_MS)
  }

  useEffect(() => cancelClose, [])

  // No dependency list: the registry always points at the latest render's handlers.
  useEffect(() =>
    registerHover(index, {
      enter: (element) => {
        cancelClose()
        card.open(element)
      },
      leave: scheduleClose,
    }),
  )

  const close = () => {
    cardHoveredRef.current = false
    cancelClose()
    card.close()
  }

  const cardEvents = {
    onMouseEnter: () => {
      cardHoveredRef.current = true
      cancelClose()
    },
    onMouseLeave: () => {
      cardHoveredRef.current = false
      scheduleClose()
    },
    onBlur: (event: FocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) scheduleClose()
    },
  }

  return { isOpen: card.isOpen, style: card.style, cardEvents, close }
}

function VariableToken({
  index,
  segment,
  variables,
  masked,
  doc,
  editState,
  registerHover,
}: {
  index: number
  segment: VariableSegment
  variables: EnvironmentVariableDto[]
  masked: boolean
  doc?: VariableDoc
  editState: TokenEditState
  registerHover: RegisterTokenHover
}) {
  const { t } = useLanguage()
  const editing = useVariableEditing()
  const cardRef = useRef<HTMLDivElement>(null)
  const preview = useTokenPreview(cardRef, index, registerHover)
  const isKnown = variables.some((variable) => variable.name === segment.name)
  const stateClassName = !isKnown ? 'var-token--unknown' : masked ? 'var-token--masked' : 'var-token--known'

  return (
    <>
      <span className={tokenClassName(`var-token ${stateClassName}`, editState, preview.isOpen)} data-token-index={index}>
        {/* Muted braces so the name stands out; the characters stay identical to the input's, keeping the caret aligned. */}
        <span className="var-token-brace">{'{{'}</span>
        {segment.raw.slice(2, -2)}
        <span className="var-token-brace">{'}}'}</span>
      </span>
      {preview.isOpen &&
        createPortal(
          <div ref={cardRef} className="var-tooltip" style={preview.style} {...preview.cardEvents}>
            <VariablePreviewCard
              name={segment.name}
              variables={variables}
              t={t}
              hideValue={masked}
              doc={doc}
              onSetValue={editing?.setValue ?? null}
              canCreate={editing?.canCreate ?? false}
              onRequestClose={preview.close}
            />
          </div>,
          document.body,
        )}
    </>
  )
}

function RouteParamToken({
  index,
  name,
  raw,
  routeParam,
  onSetValue,
  editState,
  registerHover,
}: {
  index: number
  name: string
  raw: string
  routeParam?: RouteParamEntry
  onSetValue?: (id: string, value: string) => void
  editState: TokenEditState
  registerHover: RegisterTokenHover
}) {
  const { t } = useLanguage()
  const cardRef = useRef<HTMLDivElement>(null)
  const preview = useTokenPreview(cardRef, index, registerHover)
  const inputId = useId()
  const value = routeParam?.value ?? ''
  const canEdit = !!routeParam && !!onSetValue

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    preview.close()
  }

  return (
    <>
      <span className={tokenClassName('route-param-token', editState, preview.isOpen)} data-token-index={index}>
        {raw}
      </span>
      {preview.isOpen &&
        createPortal(
          <div ref={cardRef} className="var-tooltip" style={preview.style} {...preview.cardEvents}>
            <div className="var-preview var-preview--defined">
              <div className="var-preview-header">
                <span className="var-preview-name">{name}</span>
                <span className="var-preview-badge">{t('variablePreview.pathParameter')}</span>
              </div>
              <div className="var-preview-body">
                {canEdit ? (
                  <>
                    <label className="rw-visually-hidden" htmlFor={inputId}>
                      {t('params.routeValueFieldLabel', { name })}
                    </label>
                    <input
                      id={inputId}
                      className="var-preview-input"
                      value={value}
                      placeholder={t('common.empty')}
                      onChange={(event) => {
                        if (routeParam) onSetValue?.(routeParam.id, event.target.value)
                      }}
                      onKeyDown={handleKeyDown}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </>
                ) : value === '' ? (
                  <span className="var-preview-empty">{t('common.empty')}</span>
                ) : (
                  <code className="var-preview-value">{value}</code>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

interface FieldSelection {
  start: number
  end: number
}

function editStateFor(selection: FieldSelection | null, tokenStart: number, tokenEnd: number): TokenEditState {
  if (!selection) return { active: false, selected: false }
  if (selection.start === selection.end) {
    return { active: selection.start > tokenStart && selection.start < tokenEnd, selected: false }
  }
  return { active: false, selected: selection.start < tokenEnd && selection.end > tokenStart }
}

interface RenderSegmentsOptions {
  variables: EnvironmentVariableDto[]
  masked: boolean
  variableDocs: Record<string, VariableDoc> | undefined
  highlightRouteParams: boolean
  routeParams: RouteParamEntry[] | undefined
  onUpdateRouteParamValue: ((id: string, value: string) => void) | undefined
  /** The `<input>` selection while it has focus; `null` when unfocused. */
  selection: FieldSelection | null
  registerHover: RegisterTokenHover
}

/** Em campos mascarados, o texto fora dos templates continua no overlay com
 * os caracteres reais (transparentes, cobertos por pontos via CSS) — assim a
 * largura acompanha a do `<input>` e o caret fica alinhado em qualquer fonte. */
function renderSegments(value: string, options: RenderSegmentsOptions): ReactNode[] {
  const { variables, masked, variableDocs, highlightRouteParams, routeParams, onUpdateRouteParamValue, selection, registerHover } =
    options
  const routeRanges = highlightRouteParams ? findRouteParamRanges(value) : []
  const rendered: ReactNode[] = []
  let offset = 0
  let tokenIndex = 0

  parseTemplate(value).forEach((segment, segmentIndex) => {
    if (segment.type === 'variable') {
      rendered.push(
        <VariableToken
          key={'segment-' + segmentIndex}
          index={tokenIndex++}
          segment={segment}
          variables={variables}
          masked={masked}
          doc={variableDocs?.[segment.name]}
          editState={editStateFor(selection, offset, offset + segment.raw.length)}
          registerHover={registerHover}
        />,
      )
      offset += segment.raw.length
      return
    }

    const segmentStart = offset
    const segmentEnd = segmentStart + segment.value.length
    const ranges = routeRanges.filter((range) => range.start >= segmentStart && range.end <= segmentEnd)
    let cursor = 0

    ranges.forEach((range, rangeIndex) => {
      const start = range.start - segmentStart
      const end = range.end - segmentStart
      if (start > cursor) {
        rendered.push(
          <span key={'segment-' + segmentIndex + '-text-' + rangeIndex} className={masked ? 'var-masked-text' : undefined}>
            {segment.value.slice(cursor, start)}
          </span>,
        )
      }
      const routeParam = routeParams?.find((param) => param.name === range.name)
      rendered.push(
        <RouteParamToken
          key={'segment-' + segmentIndex + '-route-' + rangeIndex}
          index={tokenIndex++}
          name={range.name}
          raw={segment.value.slice(start, end)}
          routeParam={routeParam}
          onSetValue={onUpdateRouteParamValue}
          editState={editStateFor(selection, range.start, range.end)}
          registerHover={registerHover}
        />,
      )
      cursor = end
    })

    if (cursor < segment.value.length || ranges.length === 0) {
      rendered.push(
        <span key={'segment-' + segmentIndex + '-tail'} className={masked ? 'var-masked-text' : undefined}>
          {segment.value.slice(cursor)}
        </span>,
      )
    }
    offset = segmentEnd
  })

  return rendered
}

/**
 * Campo de linha única (`<input>`) com destaque de templates `{{variável}}`,
 * tooltip com o valor e sugestões ao digitar `{{` — usado nos campos que o
 * backend interpola: URL, headers, params, corpo url-encoded/form-data e
 * autorização. Os editores de várias linhas rodam sobre CodeMirror 6 (ver
 * `template-variables-codemirror.ts`), não este componente.
 */
export function TemplateHighlightedField({
  id,
  value,
  onChange,
  variables,
  fieldClassName,
  placeholder,
  masked = false,
  suggestions: fieldSuggestions,
  templates = true,
  variableDocs,
  highlightRouteParams = false,
  routeParams,
  onUpdateRouteParamValue,
  onPaste,
  readOnly,
}: TemplateHighlightedFieldProps) {
  const { t } = useLanguage()
  const overlayRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const pendingCursorRef = useRef<number | null>(null)
  const [openQuery, setOpenQuery] = useState<OpenTemplateQuery | null>(null)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)
  const [fieldOpen, setFieldOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [selection, setSelection] = useState<FieldSelection | null>(null)
  // A Map held in state (not a ref): created once, mutated only from effects and event handlers.
  const [tokenHover] = useState(() => new Map<number, TokenHoverHandlers>())
  const hoveredTokenRef = useRef<number | null>(null)

  const registerHover: RegisterTokenHover = (index, handlers) => {
    tokenHover.set(index, handlers)
    return () => {
      if (tokenHover.get(index) === handlers) tokenHover.delete(index)
    }
  }

  /** Tokens let the pointer through to the `<input>`; hovering is detected by
   * hit-testing the pointer against the overlay's tokens (`tokenAt`). */
  const setHoveredToken = (element: HTMLElement | null) => {
    const next = element ? Number(element.dataset.tokenIndex) : null
    const previous = hoveredTokenRef.current
    if (previous === next) return
    if (previous !== null) tokenHover.get(previous)?.leave()
    hoveredTokenRef.current = next
    if (element && next !== null) tokenHover.get(next)?.enter(element)
  }

  const tokenAt = (clientX: number, clientY: number): HTMLElement | null => {
    for (const element of overlayRef.current?.querySelectorAll<HTMLElement>('[data-token-index]') ?? []) {
      const rect = element.getBoundingClientRect()
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) return element
    }
    return null
  }

  const handleMouseMove = (event: MouseEvent<HTMLInputElement>) => {
    // While drag-selecting, do not pop preview cards along the way.
    if (event.buttons !== 0) return
    setHoveredToken(tokenAt(event.clientX, event.clientY))
  }

  const syncOverlayScroll = () => {
    const overlay = overlayRef.current
    const input = inputRef.current
    if (!overlay || !input) return
    overlay.scrollLeft = input.scrollLeft
  }

  // The input may scroll horizontally without a `scroll` event (caret moved by
  // typing or by the value changing from outside): keep the overlay aligned.
  useLayoutEffect(syncOverlayScroll, [value])

  const trackSelection = (input: HTMLInputElement) => {
    const start = input.selectionStart ?? 0
    const end = input.selectionEnd ?? start
    setSelection((current) => (current && current.start === start && current.end === end ? current : { start, end }))
    syncOverlayScroll()
  }

  const suggestions = useMemo(() => {
    if (!openQuery) return []
    const needle = openQuery.query.toLowerCase()
    return variables.filter((variable) => variable.name.toLowerCase().includes(needle)).slice(0, SUGGESTIONS_MAX_ITEMS)
  }, [openQuery, variables])

  const fieldMatches = useMemo(() => {
    if (!fieldOpen || openQuery || !fieldSuggestions) return []
    const needle = value.trim().toLowerCase()
    return fieldSuggestions
      .filter((suggestion) => suggestion.value !== value && suggestion.value.toLowerCase().includes(needle))
      .slice(0, SUGGESTIONS_MAX_ITEMS)
  }, [fieldOpen, openQuery, fieldSuggestions, value])
  const hasFieldSuggestions = (fieldSuggestions?.length ?? 0) > 0

  const syncScroll = (event: UIEvent<HTMLInputElement>) => {
    const overlay = overlayRef.current
    if (!overlay) return
    overlay.scrollTop = event.currentTarget.scrollTop
    overlay.scrollLeft = event.currentTarget.scrollLeft
  }

  /** `openField`: se, sem `{{` aberto, a lista de sugestões do campo deve abrir. */
  const syncOpenQuery = (input: HTMLInputElement, openField: boolean) => {
    const cursor = input.selectionStart ?? input.value.length
    const next = templates ? findOpenTemplateQuery(input.value, cursor) : null
    const field = !next && openField && hasFieldSuggestions
    setOpenQuery(next)
    setFieldOpen(field)
    if (next || field) {
      const rect = input.getBoundingClientRect()
      // The variable list opens under the `{{` being typed; the field's own list, under the field.
      setAnchor({ left: next ? textEndLeft(input, next.start - 2) : rect.left, bottom: rect.bottom })
    } else {
      setAnchor(null)
    }
    setHighlightedIndex(0)
  }

  const closeLists = () => {
    setOpenQuery(null)
    setFieldOpen(false)
  }

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    // Token indices shift as the value changes; the next pointer move re-detects the hovered one.
    setHoveredToken(null)
    onChange(event.target.value)
    syncOpenQuery(event.target, true)
  }

  const acceptFieldSuggestion = (suggestion: FieldSuggestion) => {
    onChange(suggestion.value)
    setFieldOpen(false)
    requestAnimationFrame(() => {
      const input = inputRef.current
      if (input) input.setSelectionRange(suggestion.value.length, suggestion.value.length)
    })
  }

  const insertSuggestion = (variableName: string) => {
    if (!openQuery) return
    const cursor = inputRef.current?.selectionStart ?? openQuery.start + openQuery.query.length
    const nextValue = `${value.slice(0, openQuery.start)}${variableName}}}${value.slice(cursor)}`
    pendingCursorRef.current = openQuery.start + variableName.length + 2
    onChange(nextValue)
    setOpenQuery(null)

    // `onChange` só atualiza `value` no próximo render (controlado pelo pai)
    // — o cursor só pode ser reposicionado depois que o input já reflete o
    // novo valor, daí o `requestAnimationFrame`.
    requestAnimationFrame(() => {
      const pos = pendingCursorRef.current
      if (pos !== null && inputRef.current) {
        inputRef.current.setSelectionRange(pos, pos)
      }
      pendingCursorRef.current = null
    })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!openQuery && !fieldOpen && event.key === 'ArrowDown' && hasFieldSuggestions) {
      event.preventDefault()
      syncOpenQuery(event.currentTarget, true)
      return
    }
    if (!openQuery && fieldOpen && fieldMatches.length > 0) {
      handleListKey(event, fieldMatches.length, () => {
        const suggestion = fieldMatches[highlightedIndex]
        if (suggestion) acceptFieldSuggestion(suggestion)
      })
      return
    }
    if (!openQuery || suggestions.length === 0) return
    handleListKey(event, suggestions.length, () => {
      const suggestion = suggestions[highlightedIndex]
      if (suggestion) insertSuggestion(suggestion.name)
    })
  }

  const handleListKey = (event: KeyboardEvent<HTMLInputElement>, count: number, accept: () => void) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlightedIndex((current) => Math.min(current + 1, count - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlightedIndex((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
      // Com a lista aberta, Tab aceita a sugestão em vez de mover o foco —
      // `stopPropagation` impede também que o ciclo de foco de um modal o trate.
      event.preventDefault()
      event.stopPropagation()
      accept()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeLists()
    }
  }

  const handleKeyUp = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
      syncOpenQuery(event.currentTarget, fieldOpen)
    }
  }

  const blockClipboardWhenMasked = (event: ClipboardEvent<HTMLInputElement>) => {
    if (masked) event.preventDefault()
  }

  const suggestionsLeft = anchor
    ? Math.min(Math.max(anchor.left, VIEWPORT_MARGIN_PX), window.innerWidth - SUGGESTIONS_WIDTH_PX - VIEWPORT_MARGIN_PX)
    : 0
  const suggestionsTop = anchor ? anchor.bottom + TOOLTIP_GAP_PX : 0

  return (
    <div className="var-highlight-wrapper">
      <input
        ref={inputRef}
        id={id}
        className={`var-highlight-input ${fieldClassName}`}
        value={value}
        onChange={handleChange}
        onScroll={syncScroll}
        onClick={(event) => syncOpenQuery(event.currentTarget, true)}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredToken(null)}
        onSelect={(event) => trackSelection(event.currentTarget)}
        onFocus={(event) => trackSelection(event.currentTarget)}
        onBlur={() => {
          setSelection(null)
          closeLists()
        }}
        placeholder={placeholder}
        onCopy={blockClipboardWhenMasked}
        onCut={blockClipboardWhenMasked}
        onPaste={onPaste}
        readOnly={readOnly}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        data-masked={masked || undefined}
      />
      <div ref={overlayRef} className={`var-highlight-overlay ${fieldClassName}`} aria-hidden="true">
        <span className="var-highlight-text">
          {templates
            ? renderSegments(value, {
                variables,
                masked,
                variableDocs,
                highlightRouteParams,
                routeParams,
                onUpdateRouteParamValue,
                selection,
                registerHover,
              })
            : value}
        </span>
      </div>

      {openQuery &&
        anchor &&
        createPortal(
          <div
            className="var-suggestions"
            style={{ left: suggestionsLeft, top: suggestionsTop, width: SUGGESTIONS_WIDTH_PX }}
            role="listbox"
            aria-label={t('templateField.suggestionsAria')}
          >
            {suggestions.length === 0 ? (
              <p className="var-suggestions-empty">{t('templateField.noSuggestions')}</p>
            ) : (
              // Itens como `role="option"`, não `<button>`: o contorno global de
              // mousedown em botões (`installButtonMousedownWorkaround`) daria foco
              // ao botão antes deste handler, o `onBlur` do input fecharia a lista
              // e o clique se perderia.
              suggestions.map((variable, index) => (
                <div
                  key={variable.name}
                  role="option"
                  aria-selected={index === highlightedIndex}
                  className={index === highlightedIndex ? 'var-suggestion-item var-suggestion-item--active' : 'var-suggestion-item'}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  // `mousedown` (não `click`) com `preventDefault` mantém o foco no input — senão `onBlur` fecharia a lista antes do clique registrar.
                  onMouseDown={(event) => {
                    event.preventDefault()
                    insertSuggestion(variable.name)
                  }}
                >
                  <span className="var-suggestion-name">{variable.name}</span>
                  {variable.sensitive && <span className="var-suggestion-sensitive">{t('environments.sensitiveColumn')}</span>}
                </div>
              ))
            )}
          </div>,
          document.body,
        )}

      {!openQuery &&
        fieldOpen &&
        anchor &&
        fieldMatches.length > 0 &&
        createPortal(
          <div
            className="var-suggestions"
            style={{ left: suggestionsLeft, top: suggestionsTop, width: SUGGESTIONS_WIDTH_PX }}
            role="listbox"
            aria-label={t('templateField.fieldSuggestionsAria')}
          >
            {fieldMatches.map((suggestion, index) => (
              <div
                key={suggestion.value}
                role="option"
                aria-selected={index === highlightedIndex}
                className={index === highlightedIndex ? 'var-suggestion-item var-suggestion-item--active' : 'var-suggestion-item'}
                title={suggestion.description}
                onMouseEnter={() => setHighlightedIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault()
                  acceptFieldSuggestion(suggestion)
                }}
              >
                <span className="var-suggestion-text">
                  <span className="var-suggestion-name">{suggestion.value}</span>
                  {suggestion.description && <span className="var-suggestion-description">{suggestion.description}</span>}
                </span>
                {suggestion.detail && <span className="var-suggestion-sensitive">{suggestion.detail}</span>}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  )
}
