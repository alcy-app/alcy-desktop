import { useEffect, useRef } from 'react'
import { Compartment } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { foldGutter, foldKeymap, syntaxHighlighting } from '@codemirror/language'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import { useLanguage } from '../../../shared/i18n/use-language'
import { useShortcuts } from '../../../shared/shortcuts/use-shortcuts'
import { completionShortcutsExtension } from '../completion-shortcuts'
import type { CodeLanguage } from '../codemirror-shared'
import { editorSearchHighlightExtension } from '../editor-search'
import { bodySchemaExtension, setBodySchema } from '../schema-completions'
import type { BodySchema } from '../schema-completions'
import { environmentVariablesExtension, setEnvironmentVariables } from '../template-variables-codemirror'
import { useVariableEditing } from '../variable-editing-context'
import {
  autoCloseBracketsExtension,
  codeEditorTheme,
  codeHighlightStyle,
  editableCodeEditorTheme,
  interactiveCodeEditorTheme,
  languageExtensionFor,
  selectableLineNumbers,
  tabIndentKeymap,
  twoDigitLineNumbersTheme,
} from '../codemirror-shared'
import { EditorSearch } from './EditorSearch'
import { useEditorSearch } from './use-editor-search'
import { editorSelectionExtension, useEditorAgentBridge } from './use-editor-agent-bridge'
import type { EditorSlot } from '../editor-bridge'
import { LineCount } from './LineCount'
import './template-highlight.css'

/** Linguagem do editor mais o fechamento automático de pares, que só vale
 * para JSON (corpo) e JavaScript (scripts); XML e HTML já fecham tags pelo
 * próprio pacote de linguagem. */
function editingLanguageExtension(language: CodeLanguage): Extension {
  const autoClose = language === 'json' || language === 'javascript'
  return [languageExtensionFor(language), autoClose ? autoCloseBracketsExtension() : []]
}

interface RequestBodyPanelProps {
  value: string
  onChange: (value: string) => void
  /** Linguagem do editor; JSON por padrão (corpo da requisição). */
  language?: CodeLanguage
  /** Rótulo acessível do editor; o do corpo da requisição por padrão. */
  label?: string
  /** Extensões extras do editor (ex.: autocompletar); lidas só na montagem. */
  extraExtensions?: Extension
  /** Variáveis do ambiente ativo: com elas, o editor destaca `{{variável}}`,
   * mostra o valor ao passar o mouse e sugere nomes ao digitar `{{`. Sem elas
   * (ex.: scripts, que não são interpolados), nada disso é montado. Se o
   * editor tem ou não esse recurso é decidido na montagem. */
  environmentVariables?: EnvironmentVariableDto[]
  /** Schema do corpo JSON para sugerir chaves e valores (ADR 0035). Se o
   * editor tem esse recurso é decidido na montagem (`undefined` = nunca);
   * depois, `null` só o desliga. */
  bodySchema?: BodySchema | null
  /** Editor the agent can point at and read the selection from (ADR 0064); read only at mount. */
  agentSlot?: EditorSlot
}

/**
 * Editor de corpo da requisição sobre CodeMirror 6 — mesma base do
 * visualizador de resposta (`ResponseCodeView`), agora editável: gutter de
 * números de linha, quebra de linha e destaque de sintaxe JSON ficam
 * corretos mesmo com linhas longas, o que um `<textarea>` simples não
 * consegue sem desativar a quebra automática.
 */
export function RequestBodyPanel({
  value,
  onChange,
  language = 'json',
  label,
  extraExtensions,
  environmentVariables,
  bodySchema,
  agentSlot,
}: RequestBodyPanelProps) {
  const { t } = useLanguage()
  const editorLabel = label ?? t('requestBody.editorLabel')
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const ariaLabelCompartmentRef = useRef<Compartment | null>(null)
  const languageCompartmentRef = useRef<Compartment | null>(null)
  const onChangeRef = useRef(onChange)
  const translateRef = useRef(t)
  const setVariable = useVariableEditing()
  const setVariableRef = useRef(setVariable)
  const { bindings: shortcutBindings } = useShortcuts()
  const shortcutBindingsRef = useRef(shortcutBindings)
  const { isOpen: isSearchOpen, openSearch, closeSearch } = useEditorSearch()
  const requestedSearch = useEditorAgentBridge(agentSlot, viewRef, openSearch)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    translateRef.current = t
  }, [t])

  useEffect(() => {
    setVariableRef.current = setVariable
  }, [setVariable])

  useEffect(() => {
    shortcutBindingsRef.current = shortcutBindings
  }, [shortcutBindings])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const ariaLabelCompartment = new Compartment()
    ariaLabelCompartmentRef.current = ariaLabelCompartment
    const languageCompartment = new Compartment()
    languageCompartmentRef.current = languageCompartment

    const view = new EditorView({
      doc: value,
      extensions: [
        history(),
        completionShortcutsExtension(() => shortcutBindingsRef.current),
        tabIndentKeymap,
        keymap.of([{ key: 'Mod-f', run: openSearch }, ...foldKeymap, ...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        drawSelection(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        selectableLineNumbers(),
        foldGutter(),
        languageCompartment.of(editingLanguageExtension(language)),
        syntaxHighlighting(codeHighlightStyle),
        extraExtensions ?? [],
        environmentVariables ? environmentVariablesExtension(() => translateRef.current, () => setVariableRef.current) : [],
        bodySchema !== undefined ? bodySchemaExtension() : [],
        codeEditorTheme,
        interactiveCodeEditorTheme,
        editableCodeEditorTheme,
        twoDigitLineNumbersTheme,
        editorSearchHighlightExtension,
        editorSelectionExtension(agentSlot),
        ariaLabelCompartment.of(EditorView.contentAttributes.of({ 'aria-label': editorLabel })),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        }),
      ],
      parent: container,
    })
    viewRef.current = view
    if (environmentVariables) view.dispatch({ effects: setEnvironmentVariables.of(environmentVariables) })
    if (bodySchema) view.dispatch({ effects: setBodySchema.of(bodySchema) })

    return () => {
      view.destroy()
      viewRef.current = null
      ariaLabelCompartmentRef.current = null
      languageCompartmentRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- monta uma vez; valor/idioma/variáveis são sincronizados via dispatch abaixo, não remontagem.
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (view.state.doc.toString() === value) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    if (!view || !environmentVariables) return
    view.dispatch({ effects: setEnvironmentVariables.of(environmentVariables) })
  }, [environmentVariables])

  useEffect(() => {
    const view = viewRef.current
    if (!view || bodySchema === undefined) return
    view.dispatch({ effects: setBodySchema.of(bodySchema) })
  }, [bodySchema])

  useEffect(() => {
    const view = viewRef.current
    const languageCompartment = languageCompartmentRef.current
    if (!view || !languageCompartment) return
    view.dispatch({ effects: languageCompartment.reconfigure(editingLanguageExtension(language)) })
  }, [language])

  useEffect(() => {
    const view = viewRef.current
    const ariaLabelCompartment = ariaLabelCompartmentRef.current
    if (!view || !ariaLabelCompartment) return
    view.dispatch({
      effects: ariaLabelCompartment.reconfigure(EditorView.contentAttributes.of({ 'aria-label': editorLabel })),
    })
  }, [editorLabel])

  return (
    <div className="rw-panel rw-request-body-panel">
      <div className="rw-editor-toolbar">
        <LineCount text={value} />
      </div>
      <div className="rw-request-body-editor" ref={containerRef} />
      <EditorSearch
        requestedSearch={requestedSearch}
        text={value}
        viewRef={viewRef}
        isOpen={isSearchOpen}
        onOpen={openSearch}
        onClose={closeSearch}
      />
    </div>
  )
}
