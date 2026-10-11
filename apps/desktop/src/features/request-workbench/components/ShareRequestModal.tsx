import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap } from '@codemirror/view'
import { syntaxHighlighting } from '@codemirror/language'
import { standardKeymap } from '@codemirror/commands'
import type { AuthenticationInput } from '../../../bindings/execute-graphql-request'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import { useLanguage } from '../../../shared/i18n/use-language'
import { CopyIcon } from '../../../shared/ui/icons'
import { IconButton } from '../../../shared/ui/IconButton'
import { Modal } from '../../../shared/ui/Modal'
import { useToast } from '../../../shared/ui/use-toast'
import { codeEditorTheme, codeHighlightStyle, interactiveCodeEditorTheme } from '../codemirror-shared'
import {
  SNIPPET_LANGUAGES,
  generateSnippet,
  isSnippetLanguageId,
  type SnippetHighlight,
  type SnippetLanguageId,
} from '../code-snippets/generators'
import { loadSnippetHighlight } from '../code-snippets/snippet-highlight'
import { buildSnippetRequest, type SnippetTab } from '../code-snippets/snippet-request'
import type { WorkbenchTab } from '../request-workbench.types'
import { OptionSelect, type SelectOption } from './OptionSelect'
import './share-request-modal.css'

const LANGUAGE_OPTIONS: SelectOption<SnippetLanguageId>[] = SNIPPET_LANGUAGES.map(({ id, label }) => ({ value: id, label }))

const SHARE_LANGUAGE_STORAGE_KEY = 'alcy:share:language'

function loadPersistedLanguage(): SnippetLanguageId {
  try {
    const stored = window.localStorage.getItem(SHARE_LANGUAGE_STORAGE_KEY)
    return stored && isSnippetLanguageId(stored) ? stored : 'curl'
  } catch {
    return 'curl'
  }
}

function persistLanguage(language: SnippetLanguageId) {
  try {
    window.localStorage.setItem(SHARE_LANGUAGE_STORAGE_KEY, language)
  } catch {
    // localStorage indisponível — a escolha só não persiste entre sessões
  }
}

interface SnippetPreviewProps {
  code: string
  highlight: SnippetHighlight
  ariaLabel: string
}

/** Preview somente-leitura do código gerado, sobre CodeMirror 6. */
function SnippetPreview({ code, highlight, ariaLabel }: SnippetPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartmentRef = useRef<Compartment | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const languageCompartment = new Compartment()
    languageCompartmentRef.current = languageCompartment
    const view = new EditorView({
      extensions: [
        EditorState.readOnly.of(true),
        drawSelection(),
        keymap.of(standardKeymap),
        languageCompartment.of([]),
        EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
        syntaxHighlighting(codeHighlightStyle),
        codeEditorTheme,
        interactiveCodeEditorTheme,
      ],
      parent: container,
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
      languageCompartmentRef.current = null
    }
  }, [ariaLabel])

  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === code) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } })
  }, [code, ariaLabel])

  useEffect(() => {
    let cancelled = false
    void loadSnippetHighlight(highlight).then((extension) => {
      const view = viewRef.current
      const compartment = languageCompartmentRef.current
      if (cancelled || !view || !compartment) return
      view.dispatch({ effects: compartment.reconfigure(extension) })
    })
    return () => {
      cancelled = true
    }
  }, [highlight, ariaLabel])

  return <div ref={containerRef} className="share-modal-preview" />
}

interface ShareRequestModalProps {
  tab: SnippetTab & Pick<WorkbenchTab, 'preRequestScript' | 'postResponseScript'>
  /** Autenticação efetiva da coleção/pasta, usada quando a aba herda (`inherit`). */
  inheritedAuthentication: AuthenticationInput | undefined
  environmentVariables: EnvironmentVariableDto[]
  onClose: () => void
}

export function ShareRequestModal({ tab, inheritedAuthentication, environmentVariables, onClose }: ShareRequestModalProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const selectId = useId()
  const [languageId, setLanguageId] = useState<SnippetLanguageId>(loadPersistedLanguage)
  const language = SNIPPET_LANGUAGES.find((candidate) => candidate.id === languageId) ?? SNIPPET_LANGUAGES[0]

  const request = useMemo(
    () => buildSnippetRequest(tab, inheritedAuthentication, environmentVariables),
    [tab, inheritedAuthentication, environmentVariables],
  )
  const code = useMemo(() => generateSnippet(language.id, request), [language.id, request])
  const hasScripts = tab.preRequestScript.trim() !== '' || tab.postResponseScript.trim() !== ''

  const handleLanguageChange = (value: SnippetLanguageId) => {
    setLanguageId(value)
    persistLanguage(value)
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      showToast(t('share.copySuccess'))
    } catch {
      showToast(t('share.copyError'), 'error')
    }
  }

  return (
    <Modal
      title={t('share.title')}
      closeAriaLabel={t('collections.closeModalAria')}
      onClose={onClose}
      className="ui-modal--wide share-modal"
    >
      <div className="share-modal-toolbar">
        <label className="share-modal-language-label" htmlFor={selectId}>
          {t('share.languageLabel')}
        </label>
        <div className="share-modal-language">
          <OptionSelect id={selectId} value={language.id} options={LANGUAGE_OPTIONS} onChange={handleLanguageChange} />
        </div>
        <IconButton
          className="share-modal-copy"
          size="md"
          icon={<CopyIcon />}
          label={t('share.copy')}
          onClick={() => void handleCopy()}
        />
      </div>
      <SnippetPreview code={code} highlight={language.highlight} ariaLabel={t('share.previewLabel')} />
      {hasScripts && <p className="share-modal-note">{t('share.scriptsNotIncluded')}</p>}
    </Modal>
  )
}
