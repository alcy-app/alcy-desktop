import { useEffect, useRef } from 'react'
import { Compartment } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { foldGutter, foldKeymap, syntaxHighlighting } from '@codemirror/language'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import { useLanguage } from '../../../shared/i18n/use-language'
import { useShortcuts } from '../../../shared/shortcuts/use-shortcuts'
import { completionShortcutsExtension } from '../completion-shortcuts'
import { editorSearchHighlightExtension } from '../editor-search'
import { restoreEditorState, saveEditorState } from '../editor-state-cache'
import {
  autoCloseBracketsExtension,
  codeEditorTheme,
  codeHighlightStyle,
  editableCodeEditorTheme,
  interactiveCodeEditorTheme,
  languageExtensionFor,
  selectableLineNumbers,
  tabIndentKeymap,
} from '../codemirror-shared'
import { environmentVariablesExtension, setEnvironmentVariables } from '../template-variables-codemirror'
import { useVariableEditing } from '../variable-editing-context'
import { EditorSearch } from './EditorSearch'
import { useEditorSearch } from './use-editor-search'
import { editorSelectionExtension, useEditorAgentBridge } from './use-editor-agent-bridge'
import type { EditorSlot } from '../editor-bridge'
import { LineCount } from './LineCount'
import './template-highlight.css'

interface VariablesPanelProps {
  value: string
  onChange: (value: string) => void
  /** Variáveis do ambiente ativo — o JSON de variables é interpolado no envio,
   * então `{{variável}}` ganha destaque, tooltip e sugestões aqui. */
  environmentVariables: EnvironmentVariableDto[]
  /** Editor the agent can point at and read the selection from (ADR 0064); read only at mount. */
  agentSlot?: EditorSlot
  /** Keeps the undo history across remounts (switching sections or tabs)
   * under this key, while the text is unchanged. Read only at mount. */
  historyKey?: string
}

export function VariablesPanel({ value, onChange, environmentVariables, agentSlot, historyKey }: VariablesPanelProps) {
  const { t } = useLanguage()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const ariaLabelCompartmentRef = useRef<Compartment | null>(null)
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

    const view = new EditorView({
      state: restoreEditorState(historyKey, value, [
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
        languageExtensionFor('json'),
        autoCloseBracketsExtension(),
        syntaxHighlighting(codeHighlightStyle),
        environmentVariablesExtension(() => translateRef.current, () => setVariableRef.current),
        codeEditorTheme,
        interactiveCodeEditorTheme,
        editableCodeEditorTheme,
        editorSearchHighlightExtension,
        editorSelectionExtension(agentSlot),
        ariaLabelCompartment.of(EditorView.contentAttributes.of({ 'aria-label': t('variables.editorLabel') })),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        }),
      ]),
      parent: container,
    })
    viewRef.current = view
    view.dispatch({ effects: setEnvironmentVariables.of(environmentVariables) })

    return () => {
      saveEditorState(historyKey, view.state)
      view.destroy()
      viewRef.current = null
      ariaLabelCompartmentRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- monta uma vez; valor/idioma/variáveis são sincronizados via dispatch abaixo, não remontagem.
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === value) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: setEnvironmentVariables.of(environmentVariables) })
  }, [environmentVariables])

  useEffect(() => {
    const view = viewRef.current
    const ariaLabelCompartment = ariaLabelCompartmentRef.current
    if (!view || !ariaLabelCompartment) return
    view.dispatch({
      effects: ariaLabelCompartment.reconfigure(EditorView.contentAttributes.of({ 'aria-label': t('variables.editorLabel') })),
    })
  }, [t])

  return (
    <div className="rw-panel rw-variables-editor-panel">
      <div className="rw-editor-toolbar">
        <LineCount text={value} />
      </div>
      <div className="rw-variables-editor" ref={containerRef} />
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
