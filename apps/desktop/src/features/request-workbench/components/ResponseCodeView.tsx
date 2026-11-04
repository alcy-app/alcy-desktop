import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FocusEvent } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import type { StateEffect } from '@codemirror/state'
import { EditorView, drawSelection, gutters, highlightActiveLine, highlightActiveLineGutter, keymap } from '@codemirror/view'
import { ensureSyntaxTree, foldEffect, foldGutter, foldKeymap, foldedRanges, syntaxHighlighting, unfoldEffect } from '@codemirror/language'
import { standardKeymap } from '@codemirror/commands'
import type { ValueMonitorDto } from '../../../bindings/list-value-monitors'
import { useLanguage } from '../../../shared/i18n/use-language'
import { MenuItem } from '../../../shared/ui/Menu'
import '../../../shared/ui/menu.css'
import {
  codeEditorTheme,
  codeHighlightStyle,
  interactiveCodeEditorTheme,
  languageExtensionFor,
  selectableLineNumbers,
} from '../codemirror-shared'
import type { CodeLanguage } from '../codemirror-shared'
import { editorSearchHighlightExtension } from '../editor-search'
import type { EditorSearchRange, EditorSearchState } from '../editor-search'
import { recallResponseView, rememberResponseView } from '../response-view-memory'
import type { ResponseViewMemory } from '../response-view-memory'
import { WORKER_FORMAT_THRESHOLD_BYTES, createFormatChannel, formatOffMainThread } from '../format-off-main-thread'
import { formatResponseText } from '../response-text-format'
import { accessorFor, type JsonPathSegment } from '../json-value-index'
import type { AgentMentionRequest } from '../../agent/agent-mention-bridge'
import { MentionInChatMenuItem } from '../../agent/MentionInChatMenuItem'
import { excerptFromSelection, type ResponseExcerpt } from '../screenshot/response-excerpt'
import { highlightTreeRange, type HighlightLanguage } from '../screenshot/screenshot-highlight'
import { jsonValueAtCoords, valueCaptureExtension } from '../value-capture'
import { setMonitorHighlights, valueMonitorHighlightExtension } from '../value-monitor-highlight'
import { monitorTooltipContent } from '../value-monitor-tooltip'
import { useValueMonitorFindings } from '../use-value-monitor-findings'
import type { MonitorHighlight } from '../use-value-monitor-findings'
import { EditorSearch } from './EditorSearch'
import { useEditorSearch } from './use-editor-search'
import { editorSelectionExtension, useEditorAgentBridge } from './use-editor-agent-bridge'
import type { EditorSlot } from '../editor-bridge'
import { LineCount } from './LineCount'
import { MonitorNavigator } from './MonitorNavigator'
import './value-monitor.css'

export type ResponseCodeLanguage = CodeLanguage

interface ResponseCodeViewProps {
  text: string
  language: ResponseCodeLanguage
  /**
   * `text` é o acumulado de um corpo que ainda está carregando (JSON
   * possivelmente truncado) — formata de forma tolerante em vez de exibir
   * o texto bruto até o último chunk chegar.
   */
  partial?: boolean
  /** Quando presente, o menu de contexto de um valor JSON oferece a ação "capturar". */
  onCaptureValue?: (path: JsonPathSegment[]) => void
  /** Monitores de valores a aplicar (monitor ligado); `null`/ausente desliga os destaques. */
  monitors?: ValueMonitorDto[] | null
  /** Quantos valores reprovaram na avaliação atual (`null` sem avaliação pronta). */
  onMonitorFailedCount?: (count: number | null) => void
  /** Editor the agent can point at and read the selection from (ADR 0064); read only at mount. */
  agentSlot?: EditorSlot
  /**
   * Identifies the displayed response (tab and send). With it, scroll,
   * cursor, folds and search survive the view unmounting on a tab switch and
   * come back when the same response mounts again; read only at mount.
   */
  viewMemoryKey?: string
  /** When present, the context menu of a selection offers sharing it as an image. */
  onShareSelection?: (excerpt: ResponseExcerpt) => void
}

interface ResponseContextMenuState {
  x: number
  y: number
  selectedText: string
  /** Document range of `selectedText`. */
  selection: { from: number; to: number }
  /** Texto do valor JSON sob o clique (string sem aspas), copiado quando não há seleção. */
  valueText: string
  /** Caminho do valor JSON sob o clique, quando há um e a captura está disponível. */
  capturePath: JsonPathSegment[] | null
  /** Path of the JSON value under the click, whether or not it can be captured. */
  valuePath: JsonPathSegment[] | null
}

/** Mantém cursor e seleção legíveis mesmo quando o CodeMirror injeta seu
 * tema-base depois do CSS estático da aplicação. */
const responseCodeEditorTheme = EditorView.theme(
  {
    '&.cm-focused > .cm-scroller > .cm-cursorLayer .cm-cursor': {
      borderLeft: '2px solid var(--caret)',
      marginLeft: '-1px',
    },
  },
)

/** A response value as the agent chat mentions it: `@items[0].name`, with the value itself. */
function responseValueMention(path: JsonPathSegment[], value: string): AgentMentionRequest {
  const accessor = accessorFor(path)
  return { kind: 'field', id: `$${accessor}`, label: accessor.replace(/^\./, '') || '$', summary: value }
}

/** Texto de um valor JSON para copiar: strings sem aspas e com escapes resolvidos; o resto como está. */
function decodedValueText(raw: string): string {
  if (!raw.startsWith('"')) return raw
  try {
    return JSON.parse(raw) as string
  } catch {
    return raw
  }
}

/** Colors are only needed for the image; a parse slower than this falls back to coloring the excerpt alone. */
const EXCERPT_PARSE_TIMEOUT_MS = 200

/** The selection as an image excerpt, colored by the document's own syntax tree. */
function selectionExcerpt(state: EditorState, from: number, to: number, language: ResponseCodeLanguage): ResponseExcerpt | null {
  const text = state.sliceDoc(from, to)
  const tree = ensureSyntaxTree(state, to, EXCERPT_PARSE_TIMEOUT_MS)
  const line = state.doc.lineAt(from)
  const highlightLanguage: HighlightLanguage = language === 'none' ? 'text' : language
  return excerptFromSelection({
    text,
    spans: tree ? highlightTreeRange(tree, text, from) : undefined,
    startLine: line.number,
    startColumn: from - line.from,
    language: highlightLanguage,
  })
}

function formattedTextFor(text: string, language: ResponseCodeLanguage, partial: boolean): string {
  if (language === 'json' || language === 'xml') return formatResponseText(text, language, partial)
  return text
}

export { WORKER_FORMAT_THRESHOLD_BYTES }

function shouldOffloadFormatting(text: string, language: ResponseCodeLanguage): language is 'json' | 'xml' {
  return (language === 'json' || language === 'xml') && text.length >= WORKER_FORMAT_THRESHOLD_BYTES
}

/**
 * Formata `text` conforme `language`. Documentos grandes começam com o
 * texto bruto (disponível na hora) e trocam pelo formatado assim que
 * `formatOffMainThread` resolve — uma mudança de `text`/`language` antes
 * disso descarta o resultado pendente, nunca aplicando uma formatação
 * desatualizada por cima de um conteúdo mais recente. Exceção: quando o
 * texto novo só estende o anterior (carregamento progressivo de um corpo
 * `windowed`), o formatado anterior continua na tela até o novo chegar, em
 * vez de piscar de volta para o bruto a cada chunk.
 */
interface AsyncFormatResult {
  text: string
  language: ResponseCodeLanguage
  partial: boolean
  formatted: string
}

function useFormattedText(text: string, language: ResponseCodeLanguage, partial: boolean): string {
  const offload = shouldOffloadFormatting(text, language)
  const immediate = useMemo(() => (offload ? text : formattedTextFor(text, language, partial)), [text, language, offload, partial])
  const [asyncResult, setAsyncResult] = useState<AsyncFormatResult | null>(null)
  // Um canal por visualização: versões intermediárias do texto que ninguém
  // vai ver não chegam a ser formatadas (ver `FormatChannel`).
  const [channel] = useState(createFormatChannel)

  useEffect(() => {
    if (!offload) return
    let cancelled = false

    void formatOffMainThread(text, language, { partial, channel }).then((formatted) => {
      if (!cancelled && formatted !== null) setAsyncResult({ text, language, partial, formatted })
    })

    return () => {
      cancelled = true
    }
  }, [text, language, offload, partial, channel])

  // O resultado assíncrono só vale para o `text`/`language` que o geraram —
  // uma mudança nesse meio tempo deixa `asyncResult` desatualizado; em vez
  // de limpá-lo de volta a `null` sincronamente dentro do efeito (o próprio
  // padrão que `react-hooks/set-state-in-effect` sinaliza), comparamos a
  // chave aqui, na renderização.
  // Memoizado: `startsWith` percorre o texto inteiro (vários MB) e não
  // precisa rodar de novo numa renderização em que nada disso mudou.
  return useMemo(() => {
    if (!offload || asyncResult?.language !== language) return immediate
    const isCurrent = asyncResult.text === text && asyncResult.partial === partial
    const isPrefixOfCurrent = !isCurrent && text.startsWith(asyncResult.text)
    return isCurrent || isPrefixOfCurrent ? asyncResult.formatted : immediate
  }, [offload, asyncResult, language, text, partial, immediate])
}

const CLOSED_SEARCH: EditorSearchState = { isOpen: false, query: '', matchCase: false, wholeWord: false, regularExpression: false, activeIndex: 0 }

/** Puts the view back where `memory` was taken; only on the same document, which positions refer to. */
function restoreViewMemory(view: EditorView, memory: ResponseViewMemory): boolean {
  if (view.state.doc.length !== memory.docLength) return false
  const effects: StateEffect<unknown>[] = memory.folds.map((range) => foldEffect.of(range))
  if (memory.scroll) effects.push(memory.scroll)
  view.dispatch({ selection: memory.selection, effects })
  return true
}

function foldedRangesOf(state: EditorState): EditorSearchRange[] {
  const folds: EditorSearchRange[] = []
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    folds.push({ from, to })
  })
  return folds
}

/** Tamanho do trecho inicial que `a` e `b` têm em comum. */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

/**
 * Visualizador somente-leitura do corpo de resposta, sobre CodeMirror 6:
 * renderiza como DOM só as linhas visíveis no viewport, então formatar e
 * destacar sintaxe não trava a navegação, independente do tamanho do corpo
 * (substitui o tokenizer manual + `<span>` por token e a degradação por
 * limiar de tamanho).
 */
export function ResponseCodeView({
  text,
  language,
  partial = false,
  onCaptureValue,
  monitors = null,
  onMonitorFailedCount,
  agentSlot,
  viewMemoryKey,
  onShareSelection,
}: ResponseCodeViewProps) {
  const { t } = useLanguage()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartmentRef = useRef<Compartment | null>(null)
  const ariaLabelCompartmentRef = useRef<Compartment | null>(null)
  const [contextMenu, setContextMenu] = useState<ResponseContextMenuState | null>(null)
  const [memoryKey] = useState(viewMemoryKey)
  const [memory] = useState(() => (memoryKey === undefined ? null : recallResponseView(memoryKey)))
  // Not applied yet: the document it refers to may still be loading or formatting.
  const pendingMemoryRef = useRef(memory)
  // Updated on scroll, while the view is laid out: once unmounting or hidden, its scrollTop reads 0.
  const scrollSnapshotRef = useRef<StateEffect<unknown> | null>(memory?.scroll ?? null)
  const searchStateRef = useRef<EditorSearchState>(memory?.search ?? CLOSED_SEARCH)
  const rememberSearchState = useCallback((state: EditorSearchState) => {
    searchStateRef.current = state
  }, [])
  const { isOpen: isSearchOpen, openSearch, closeSearch } = useEditorSearch(memory?.search.isOpen ?? false)
  const mountedLanguageRef = useRef(language)
  const dropPendingMemory = () => {
    pendingMemoryRef.current = null
  }
  const requestedSearch = useEditorAgentBridge(agentSlot, viewRef, openSearch)
  const formatted = useFormattedText(text, language, partial)
  // Em JSON, valores ganham destaque ao passar o mouse e podem ser copiados
  // (ou capturados, com `onCaptureValue`) pelo menu de contexto.
  const isJsonRef = useRef(false)
  const onCaptureValueRef = useRef(onCaptureValue)
  const findings = useValueMonitorFindings(formatted, language === 'json', partial, monitors)
  const highlights = findings?.status === 'ready' ? findings.highlights : null
  // Lidos no hover (tooltip), não capturados na criação da extensão.
  const monitorsRef = useRef(monitors)
  const translateRef = useRef(t)
  const onMonitorFailedCountRef = useRef(onMonitorFailedCount)

  useEffect(() => {
    onCaptureValueRef.current = onCaptureValue
    isJsonRef.current = language === 'json'
    monitorsRef.current = monitors
    translateRef.current = t
    onMonitorFailedCountRef.current = onMonitorFailedCount
  }, [language, onCaptureValue, monitors, t, onMonitorFailedCount])

  // Layout effect: the view exists before the children's effects run, so a
  // search restored open can highlight its matches on mount.
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const languageCompartment = new Compartment()
    const ariaLabelCompartment = new Compartment()
    languageCompartmentRef.current = languageCompartment
    ariaLabelCompartmentRef.current = ariaLabelCompartment

    const view = new EditorView({
      doc: formatted,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.lineWrapping,
        drawSelection(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        // Margem fora do `position: sticky` padrão: com `lineWrapping` não há
        // rolagem horizontal para ela acompanhar, e a camada sticky (tão alta
        // quanto o documento inteiro) deixava de ser repintada em rolagem
        // rápida de respostas grandes — os números de linha sumiam.
        gutters({ fixed: false }),
        selectableLineNumbers(),
        foldGutter(),
        keymap.of([{ key: 'Mod-f', run: openSearch }, ...foldKeymap, ...standardKeymap]),
        languageCompartment.of(languageExtensionFor(language)),
        ariaLabelCompartment.of(EditorView.contentAttributes.of({ 'aria-label': t('response.bodyEditorLabel') })),
        EditorView.domEventObservers({
          scroll(_event, editor) {
            if (!pendingMemoryRef.current) scrollSnapshotRef.current = editor.scrollSnapshot()
          },
          // Navigating before the remembered document is back: where the user goes now wins.
          wheel: dropPendingMemory,
          pointerdown: dropPendingMemory,
          keydown: dropPendingMemory,
        }),
        EditorView.domEventHandlers({
          contextmenu(event, editor) {
            event.preventDefault()
            const selection = editor.state.selection.main
            const selectedText = selection.empty ? '' : editor.state.sliceDoc(selection.from, selection.to)
            const menuWidth = 220
            const menuHeight = 140
            const value = isJsonRef.current ? jsonValueAtCoords(editor, event.clientX, event.clientY) : null
            const capturePath = onCaptureValueRef.current ? (value?.path ?? null) : null
            const valueText = value ? decodedValueText(editor.state.sliceDoc(value.from, value.to)) : ''
            setContextMenu({
              x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
              y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
              selectedText,
              selection: { from: selection.from, to: selection.to },
              valueText,
              capturePath,
              valuePath: value?.path ?? null,
            })
            return true
          },
        }),
        valueCaptureExtension(() => isJsonRef.current),
        valueMonitorHighlightExtension((highlight) => monitorTooltipContent(highlight, monitorsRef.current ?? [], translateRef.current)),
        syntaxHighlighting(codeHighlightStyle),
        codeEditorTheme,
        interactiveCodeEditorTheme,
        responseCodeEditorTheme,
        editorSearchHighlightExtension,
        editorSelectionExtension(agentSlot),
      ],
      parent: container,
    })
    viewRef.current = view
    if (pendingMemoryRef.current && restoreViewMemory(view, pendingMemoryRef.current)) pendingMemoryRef.current = null

    return () => {
      if (memoryKey !== undefined) {
        const search = searchStateRef.current
        const pending = pendingMemoryRef.current
        const { anchor, head } = view.state.selection.main
        const latest: ResponseViewMemory = pending
          ? { ...pending, search }
          : { docLength: view.state.doc.length, scroll: scrollSnapshotRef.current, selection: { anchor, head }, folds: foldedRangesOf(view.state), search }
        rememberResponseView(memoryKey, latest)
        // A view created again by this same component (StrictMode) starts where this one was.
        pendingMemoryRef.current = latest
      }
      view.destroy()
      viewRef.current = null
      languageCompartmentRef.current = null
      ariaLabelCompartmentRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- monta uma vez; conteúdo/linguagem são atualizados via dispatch abaixo, não remontagem.
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === formatted) return
    // Troca só o trecho que mudou: no carregamento progressivo o documento
    // cresce pelo fim, e substituí-lo inteiro a cada chunk reiniciaria a
    // rolagem, a seleção e o realce do que já estava na tela.
    const from = commonPrefixLength(current, formatted)
    view.dispatch({ changes: { from, to: current.length, insert: formatted.slice(from) } })
    if (pendingMemoryRef.current && restoreViewMemory(view, pendingMemoryRef.current)) pendingMemoryRef.current = null
  }, [formatted])

  // Depois da sincronização do documento acima: as faixas valem para `formatted`.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setMonitorHighlights.of(highlights ?? []) })
  }, [formatted, highlights])

  useEffect(() => {
    onMonitorFailedCountRef.current?.(highlights ? highlights.filter((highlight) => highlight.failed).length : null)
  }, [highlights])

  useEffect(() => () => onMonitorFailedCountRef.current?.(null), [])

  useEffect(() => {
    const view = viewRef.current
    const languageCompartment = languageCompartmentRef.current
    if (!view || !languageCompartment) return
    // Another format is another document: the remembered positions no longer apply.
    if (language !== mountedLanguageRef.current) pendingMemoryRef.current = null
    view.dispatch({ effects: languageCompartment.reconfigure(languageExtensionFor(language)) })
  }, [language])

  useEffect(() => {
    const view = viewRef.current
    const ariaLabelCompartment = ariaLabelCompartmentRef.current
    if (!view || !ariaLabelCompartment) return
    view.dispatch({
      effects: ariaLabelCompartment.reconfigure(EditorView.contentAttributes.of({ 'aria-label': t('response.bodyEditorLabel') })),
    })
  }, [t])

  useEffect(() => {
    if (!contextMenu) return

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node | null)) setContextMenu(null)
    }
    const close = () => setContextMenu(null)

    window.addEventListener('pointerdown', closeOnOutsidePointer)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [contextMenu])

  const closeContextMenuOnBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setContextMenu(null)
    }
  }

  const copySelection = async () => {
    const textToCopy = contextMenu?.selectedText || contextMenu?.valueText
    if (!textToCopy || !navigator.clipboard) return
    try {
      await navigator.clipboard.writeText(textToCopy)
    } catch {
      // Clipboard indisponível ou sem permissão: o menu apenas se fecha.
    } finally {
      setContextMenu(null)
      viewRef.current?.focus()
    }
  }

  /** Seleciona o valor, abre as dobras que o escondem e rola até ele. */
  const revealHighlight = (highlight: MonitorHighlight) => {
    const view = viewRef.current
    if (!view) return
    const unfold: ReturnType<typeof unfoldEffect.of>[] = []
    foldedRanges(view.state).between(highlight.from, highlight.to, (from, to) => {
      unfold.push(unfoldEffect.of({ from, to }))
    })
    view.dispatch({
      selection: { anchor: highlight.from, head: highlight.to },
      effects: [...unfold, EditorView.scrollIntoView(highlight.from, { y: 'center' })],
    })
  }

  const shareSelection = () => {
    const view = viewRef.current
    const range = contextMenu?.selection
    setContextMenu(null)
    if (!view || !range) return
    const excerpt = selectionExcerpt(view.state, range.from, range.to, language)
    if (excerpt) onShareSelection?.(excerpt)
  }

  const captureValue = () => {
    const path = contextMenu?.capturePath
    setContextMenu(null)
    if (path) onCaptureValueRef.current?.(path)
    viewRef.current?.focus()
  }

  return (
    <>
      <div className="rw-code-view-frame">
        <div className="rw-code-block rw-code-view" ref={containerRef} />
        <EditorSearch
          requestedSearch={requestedSearch}
          text={formatted}
          viewRef={viewRef}
          isOpen={isSearchOpen}
          onOpen={openSearch}
          onClose={closeSearch}
          placement="response"
          initialState={memory?.search}
          onStateChange={rememberSearchState}
        />
        {findings && <MonitorNavigator findings={findings} onReveal={revealHighlight} />}
      </div>
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="ui-menu rw-response-code-context-menu"
          role="menu"
          aria-label={t('response.bodyContextMenuLabel')}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onBlur={closeContextMenuOnBlur}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setContextMenu(null)
              viewRef.current?.focus()
            }
          }}
        >
          <MenuItem
            label={t('response.copySelection')}
            disabled={!contextMenu.selectedText && !contextMenu.valueText}
            autoFocus
            onSelect={() => void copySelection()}
          />
          {onShareSelection && contextMenu.selectedText.trim() && (
            <MenuItem label={t('response.shareSelectionAsImage')} onSelect={shareSelection} />
          )}
          {contextMenu.capturePath && (
            <MenuItem label={t('response.captureInScript')} onSelect={captureValue} />
          )}
          {agentSlot === 'response' && contextMenu.valuePath && (
            <MentionInChatMenuItem item={responseValueMention(contextMenu.valuePath, contextMenu.valueText)} onDone={() => setContextMenu(null)} />
          )}
        </div>
      )}
      <LineCount text={formatted} className="rw-line-count--response" />
    </>
  )
}
