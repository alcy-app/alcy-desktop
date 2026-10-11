import { EditorView, ViewPlugin, keymap, lineNumbers, tooltips, type Command } from '@codemirror/view'
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { indentLess, indentMore } from '@codemirror/commands'
import { HighlightStyle, indentUnit } from '@codemirror/language'
import { json as jsonLanguage } from '@codemirror/lang-json'
import { xml as xmlLanguage } from '@codemirror/lang-xml'
import { javascript as javascriptLanguage } from '@codemirror/lang-javascript'
import { tags } from '@lezer/highlight'

export type CodeLanguage = 'json' | 'xml' | 'javascript' | 'html' | 'none'

/**
 * Mesmas cores das classes `.json-token--*`/`.xml-token--*` (ver
 * `request-workbench.css`) — só muda o motor que as aplica. `var(--token)`
 * aqui é uma string CSS de verdade injetada via `EditorView.theme` (uma
 * folha de estilo real), não um valor computado uma vez, então segue o tema
 * claro/escuro do app normalmente. Compartilhado entre o visualizador de
 * resposta e o editor de corpo da requisição — ambos sobre CodeMirror 6.
 */
export const codeHighlightStyle = HighlightStyle.define([
  { tag: [tags.propertyName, tags.tagName], color: 'var(--accent-strong)', fontWeight: 600 },
  { tag: [tags.string, tags.attributeValue], color: 'var(--success)' },
  { tag: tags.number, color: 'var(--warning)' },
  { tag: [tags.bool, tags.null, tags.keyword, tags.atom], color: 'var(--accent)' },
  { tag: tags.attributeName, color: 'var(--accent)' },
  { tag: tags.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: [tags.punctuation, tags.separator, tags.bracket, tags.angleBracket, tags.meta, tags.processingInstruction], color: 'var(--text-muted)' },
])

export const codeEditorTheme = EditorView.theme({
  '&': {
    color: 'var(--text)',
    backgroundColor: 'transparent',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--font-size-md)',
  },
  '.cm-content': { padding: 0 },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--text-muted)',
    border: 'none',
    borderRight: '1px solid var(--border)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 4px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit' },
  // Remove o box padrão do CodeMirror para tooltips (usado pelo hover de
  // `{{variável}}`) — o cartão já se estiliza sozinho via `.var-preview`
  // (ver `variable-preview.ts` e `template-highlight.css`).
  '.cm-tooltip': { backgroundColor: 'transparent', border: 'none' },
})

/** Interações comuns aos editores de request e ao visualizador de resposta:
 * seleção com contraste consistente e margem de linhas acionável. */
export const interactiveCodeEditorTheme = EditorView.theme(
  {
    '& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
      backgroundColor: 'var(--selection-bg)',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      cursor: 'pointer',
    },
    '.cm-lineNumbers .cm-gutterElement:hover': {
      color: 'var(--text-heading)',
      backgroundColor: 'var(--surface-raised)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--accent-soft)',
    },
    '.cm-activeLine': {
      backgroundColor: 'var(--accent-softer)',
    },
  },
)

/** Números de linha que também funcionam como margem de seleção. */
export function selectableLineNumbers() {
  return lineNumbers({
    domEventHandlers: {
      mousedown(editor, block, event) {
        if (!(event instanceof MouseEvent) || event.button !== 0) return false
        event.preventDefault()
        const gutterElement = event.target instanceof Element ? event.target.closest('.cm-gutterElement') : null
        const clickedLineNumber = Number(gutterElement?.textContent)
        const line = Number.isInteger(clickedLineNumber) && clickedLineNumber >= 1 && clickedLineNumber <= editor.state.doc.lines
          ? editor.state.doc.line(clickedLineNumber)
          : editor.state.doc.lineAt(block.from)
        editor.dispatch({
          selection: { anchor: line.from, head: line.to },
          scrollIntoView: true,
        })
        editor.focus()
        return true
      },
    },
  })
}

/** Reserva na margem de números de linha espaço para dois dígitos desde o
 * início, para o texto não deslocar para a direita conforme o documento
 * cresce (o CodeMirror dimensiona a margem pelo maior número de linha). O
 * `12px` corresponde ao padding horizontal de `.cm-gutterElement` definido
 * em `codeEditorTheme` (box-sizing: border-box). */
export const twoDigitLineNumbersTheme = EditorView.theme({
  '.cm-lineNumbers .cm-gutterElement': { minWidth: 'calc(2ch + 12px)' },
})

/** Tema aplicado somente aos editores editáveis de requisição. Declarar o
 * caret na extensão do CodeMirror evita que o tema-base injetado em runtime
 * restaure a borda preta quando o editor recebe foco. */
export const editableCodeEditorTheme = EditorView.theme(
  {
    '&.cm-focused > .cm-scroller > .cm-cursorLayer .cm-cursor': {
      borderLeft: '2px solid var(--caret)',
      marginLeft: '-1px',
    },
    '.cm-dropCursor': {
      borderLeft: '2px solid var(--caret)',
      marginLeft: '-1px',
    },
  },
)

/** Tab sem seleção insere uma unidade de indentação no cursor; com seleção,
 * indenta as linhas selecionadas. */
export const insertIndentOrIndentMore: Command = (view) => {
  if (view.state.selection.ranges.some((range) => !range.empty)) return indentMore(view)
  view.dispatch(view.state.replaceSelection(view.state.facet(indentUnit)), { scrollIntoView: true, userEvent: 'input' })
  return true
}

/** Tab/Shift+Tab indentam dentro dos editores editáveis em vez de mover o
 * foco. Esc seguido de Tab ainda sai do editor (modo de foco do CodeMirror). */
export const tabIndentKeymap = keymap.of([
  { key: 'Tab', run: insertIndentOrIndentMore, shift: indentLess },
])

export function languageExtensionFor(language: CodeLanguage): Extension {
  if (language === 'json') return jsonLanguage()
  if (language === 'xml') return xmlLanguage()
  if (language === 'javascript') return javascriptLanguage()
  if (language === 'html') return lazyLanguageExtension(loadHtmlLanguage)
  return []
}

// HTML (que traz junto os pacotes de CSS e JavaScript embutidos) só aparece
// numa resposta HTML: o pacote fica num chunk próprio, carregado uma vez.
let htmlLanguageModule: Promise<typeof import('@codemirror/lang-html')> | null = null
function loadHtmlLanguage(): Promise<Extension> {
  htmlLanguageModule ??= import('@codemirror/lang-html')
  return htmlLanguageModule.then((module) => module.html())
}

/**
 * Linguagem carregada sob demanda: o editor abre sem destaque e ganha a
 * linguagem assim que o módulo chega. Se a extensão sair do editor antes
 * disso (troca de linguagem, editor destruído), nada é aplicado.
 */
function lazyLanguageExtension(load: () => Promise<Extension>): Extension {
  const compartment = new Compartment()
  return [
    compartment.of([]),
    ViewPlugin.define((view) => {
      let active = true
      void load().then((extension) => {
        if (active) view.dispatch({ effects: compartment.reconfigure(extension) })
      })
      return {
        destroy() {
          active = false
        },
      }
    }),
  ]
}

/** Fecha automaticamente os pares definidos nos dados da linguagem ativa
 * (JSON: `{`, `[`, `"`; JavaScript: também `(`, `'` e crase). Backspace
 * entre um par vazio apaga os dois; digitar o fechamento sobre um já
 * inserido apenas avança. O keymap tem precedência alta para vencer o
 * Backspace do `defaultKeymap`. */
export function autoCloseBracketsExtension(): Extension {
  return [closeBrackets(), Prec.high(keymap.of(closeBracketsKeymap))]
}

/** O editor de query GraphQL não tem pacote de linguagem, então os pares vêm
 * daqui: sem aspas simples, que GraphQL não usa para strings. */
export function graphqlAutoCloseExtension(): Extension {
  return [
    EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['(', '[', '{', '"'] } }]),
    autoCloseBracketsExtension(),
  ]
}

/** Tooltips do editor (lista de autocompletar, descrição da sugestão, hover
 * de `{{variável}}`) presos a `document.body`: dentro do editor, os painéis
 * com `overflow: hidden` cortavam a descrição que abre ao lado da lista. */
export function floatingTooltips(): Extension {
  return tooltips({ parent: document.body })
}

/** Visual da lista de autocompletar do CodeMirror — editores de script e
 * sugestões de variáveis de ambiente `{{nome}}`. */
export const completionTheme = EditorView.theme({
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--surface-overlay)',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius-md)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--font-size-sm)',
    color: 'var(--text)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--selection-bg)',
    color: 'var(--text)',
  },
  '.cm-completionDetail': { color: 'var(--text-muted)', fontStyle: 'normal', marginLeft: '8px' },
  '.cm-completionInfo': {
    backgroundColor: 'var(--surface-overlay)',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius-md)',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-sans)',
    padding: '4px 8px',
  },
})
