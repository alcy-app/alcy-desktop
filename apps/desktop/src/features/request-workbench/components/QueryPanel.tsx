import { useEffect, useMemo, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import type { LoadSchemaOutput } from '../../../bindings/load-schema'
import { useLanguage } from '../../../shared/i18n/use-language'
import { useShortcuts } from '../../../shared/shortcuts/use-shortcuts'
import { IconButton } from '../../../shared/ui/IconButton'
import { Tooltip } from '../../../shared/ui/Tooltip'
import { FormatIcon } from '../../../shared/ui/icons'
import { completionShortcutsExtension } from '../completion-shortcuts'
import { editorSearchHighlightExtension } from '../editor-search'
import { graphqlCompletionExtension, setQuerySchema } from '../graphql-completions'
import { templateVariableCompletionSource } from '../template-variables-codemirror'
import {
  codeEditorTheme,
  editableCodeEditorTheme,
  graphqlAutoCloseExtension,
  interactiveCodeEditorTheme,
  selectableLineNumbers,
  tabIndentKeymap,
} from '../codemirror-shared'
import { formatGraphqlQuery } from '../graphql-format'
import { graphqlQueryHighlight, setQueryVariables } from '../graphql-query-highlight'
import { useVariableEditing } from '../variable-editing-context'
import { EditorSearch } from './EditorSearch'
import { useEditorSearch } from './use-editor-search'
import { editorSelectionExtension, useEditorAgentBridge } from './use-editor-agent-bridge'
import type { EditorSlot } from '../editor-bridge'
import { LineCount } from './LineCount'
import './template-highlight.css'

interface QueryPanelProps {
  value: string
  onChange: (value: string) => void
  environmentVariables: EnvironmentVariableDto[]
  /** Schema carregado, para sugerir campos e argumentos; `null` desliga as sugestões do schema. */
  schema: LoadSchemaOutput | null
  /** Editor the agent can point at and read the selection from (ADR 0064); read only at mount. */
  agentSlot?: EditorSlot
}

/**
 * Editor de query GraphQL sobre CodeMirror 6 — mesma base do corpo da
 * requisição (`RequestBodyPanel`) e do visualizador de resposta, com
 * destaque de sintaxe GraphQL e templates `{{variável}}` (com tooltip)
 * reimplementados como decorações do CodeMirror em vez do overlay manual de
 * `TemplateHighlightedField` (que segue existindo só para o campo de URL,
 * de linha única — ver `EndpointBar`).
 */
export function QueryPanel({ value, onChange, environmentVariables, schema, agentSlot }: QueryPanelProps) {
  const { t } = useLanguage()
  const formatted = useMemo(() => formatGraphqlQuery(value), [value])

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
    // `{{variável}}` também é interpolado na query; a fonte é criada uma vez
    // (o CodeMirror associa resultados pendentes à fonte por identidade).
    const variableCompletionData = [{ autocomplete: templateVariableCompletionSource(() => translateRef.current) }]

    const view = new EditorView({
      doc: value,
      extensions: [
        history(),
        completionShortcutsExtension(() => shortcutBindingsRef.current),
        tabIndentKeymap,
        keymap.of([{ key: 'Mod-f', run: openSearch }, ...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        drawSelection(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        selectableLineNumbers(),
        graphqlQueryHighlight(() => translateRef.current, () => setVariableRef.current),
        graphqlAutoCloseExtension(),
        graphqlCompletionExtension(),
        EditorState.languageData.of(() => variableCompletionData),
        codeEditorTheme,
        interactiveCodeEditorTheme,
        editableCodeEditorTheme,
        editorSearchHighlightExtension,
        editorSelectionExtension(agentSlot),
        ariaLabelCompartment.of(EditorView.contentAttributes.of({ 'aria-label': t('query.editorLabel') })),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        }),
      ],
      parent: container,
    })
    viewRef.current = view
    view.dispatch({ effects: [setQueryVariables.of(environmentVariables), setQuerySchema.of(schema)] })

    return () => {
      view.destroy()
      viewRef.current = null
      ariaLabelCompartmentRef.current = null
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
    if (!view) return
    view.dispatch({ effects: setQueryVariables.of(environmentVariables) })
  }, [environmentVariables])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setQuerySchema.of(schema) })
  }, [schema])

  useEffect(() => {
    const view = viewRef.current
    const ariaLabelCompartment = ariaLabelCompartmentRef.current
    if (!view || !ariaLabelCompartment) return
    view.dispatch({
      effects: ariaLabelCompartment.reconfigure(EditorView.contentAttributes.of({ 'aria-label': t('query.editorLabel') })),
    })
  }, [t])

  return (
    <div className="rw-panel rw-query-editor-panel">
      <div className="rw-editor-toolbar">
        <LineCount text={value} />
        <Tooltip label={t('query.formatButton')} side="bottom">
          <IconButton
            className="rw-query-format-button"
            icon={<FormatIcon size={16} />}
            label={t('query.formatButton')}
            tooltip={false}
            onClick={() => {
              if (formatted !== null) onChange(formatted)
            }}
            disabled={formatted === null}
          />
        </Tooltip>
      </div>
      <div className="rw-query-editor" ref={containerRef} />
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
