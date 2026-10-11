import { useId, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Translate } from '../template-highlight'
import type { EffectiveVariable } from '../collection-tree'
import type { SetVariableValue } from '../variable-editing-context'
import { variablePreviewFor } from '../variable-preview'
import type { VariablePreviewState } from '../variable-preview'
import './template-highlight.css'

const BADGE_KEYS = {
  defined: 'variablePreview.defined',
  sensitive: 'variablePreview.sensitive',
  hidden: 'variablePreview.hidden',
  undefined: 'variablePreview.undefined',
} as const

const HINT_KEYS = {
  sensitive: 'variablePreview.sensitiveHint',
  hidden: 'variablePreview.hiddenHint',
  undefined: 'variablePreview.undefinedHint',
} as const

/** O que a documentação importada diz sobre um parâmetro de path que a URL
 * usa como `{{nome}}` (ADR 0035). */
export interface VariableDoc {
  type: string | null
  required: boolean
  description: string
}

interface VariablePreviewCardProps {
  name: string
  /** Variáveis vigentes; as de coleção/pasta trazem a origem, mostrada no cartão. */
  variables: EffectiveVariable[]
  /** Recebido por prop (não `useLanguage`): o cartão também é montado numa raiz React própria, dentro do tooltip do CodeMirror. */
  t: Translate
  /** Campo mascarado (senha): o valor nunca aparece em claro, nem de variável não sensível. */
  hideValue?: boolean
  /** Com ambiente ativo ou variável de coleção/pasta, o valor é editável no próprio cartão. */
  onSetValue: SetVariableValue | null
  /** Uma variável indefinida pode ser criada (há ambiente ativo). */
  canCreate?: boolean
  /** Fecha a pré-visualização — Enter ou Esc no campo de valor. */
  onRequestClose?: () => void
  /** Documentação do parâmetro de path de mesmo nome, quando houver. */
  doc?: VariableDoc
}

/**
 * Pré-visualização de `{{nome}}` ao passar o mouse: cabeçalho com o nome e um
 * selo de estado; no corpo, o valor — editável quando há ambiente ativo, com
 * cada alteração gravada na hora no ambiente (como no painel de Ambientes).
 * Valores sensíveis, ou em campos mascarados, são editados num campo de senha.
 */
export function VariablePreviewCard({
  name,
  variables,
  t,
  hideValue = false,
  onSetValue,
  canCreate = true,
  onRequestClose,
  doc,
}: VariablePreviewCardProps) {
  const inputId = useId()
  const variable = variables.find((candidate) => candidate.name === name)
  const externalValue = variable?.value
  const [draft, setDraft] = useState(externalValue ?? '')
  // Acompanha mudanças de fora (ex.: variável definida no painel de Ambientes
  // com o cartão aberto). No tooltip do CodeMirror as variáveis não mudam
  // depois da montagem, então lá o rascunho local é a fonte do valor exibido.
  const [syncedExternalValue, setSyncedExternalValue] = useState(externalValue)
  if (externalValue !== syncedExternalValue) {
    setSyncedExternalValue(externalValue)
    if (externalValue !== undefined) setDraft(externalValue)
  }
  // Criada por este cartão: o tooltip do CodeMirror não recebe as variáveis
  // atualizadas, então o estado local garante a troca para o campo de valor.
  const [created, setCreated] = useState(false)

  const preview = variablePreviewFor(name, variables, { hideValue })
  const state: VariablePreviewState = preview.state === 'undefined' && created ? 'defined' : preview.state
  const canEdit = onSetValue !== null && name !== ''

  const updateValue = (value: string) => {
    setDraft(value)
    if (variable?.source) onSetValue?.(name, value, variable.source)
    else onSetValue?.(name, value)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onRequestClose?.()
  }

  const renderBody = () => {
    if (canEdit && state !== 'undefined') {
      return (
        <>
          <label className="rw-visually-hidden" htmlFor={inputId}>
            {t('variablePreview.valueLabel', { name })}
          </label>
          <input
            id={inputId}
            className="var-preview-input"
            type={state === 'defined' ? 'text' : 'password'}
            value={draft}
            placeholder={t('common.empty')}
            onChange={(event) => updateValue(event.target.value)}
            onKeyDown={handleKeyDown}
            // Só ao criar pelo botão: abrir o cartão no hover não pode tirar o foco do campo em edição.
            autoFocus={created}
            spellCheck={false}
            autoComplete="off"
          />
        </>
      )
    }
    if (state === 'defined') {
      const value = preview.value ?? ''
      return value === '' ? (
        <span className="var-preview-empty">{t('common.empty')}</span>
      ) : (
        <code className="var-preview-value">{preview.truncated ? `${value}…` : value}</code>
      )
    }
    return (
      <>
        <span className="var-preview-hint">{t(HINT_KEYS[state])}</span>
        {state === 'undefined' && canEdit && canCreate && (
          <button
            type="button"
            className="var-preview-action"
            onClick={() => {
              onSetValue(name, '')
              setDraft('')
              setCreated(true)
            }}
          >
            {t('variablePreview.create')}
          </button>
        )}
      </>
    )
  }

  return (
    <div className={`var-preview var-preview--${state}`}>
      <div className="var-preview-header">
        <span className="var-preview-name">{name}</span>
        <span className="var-preview-badge">{t(BADGE_KEYS[state])}</span>
      </div>
      {variable?.source && (
        <div className="var-preview-source">
          {t(variable.source.kind === 'collection' ? 'variablePreview.fromCollection' : 'variablePreview.fromFolder', {
            name: variable.source.name,
          })}
        </div>
      )}
      {doc && (
        <div className="var-preview-doc">
          <span className="var-preview-doc-meta">
            {[t('variablePreview.pathParameter'), doc.type, doc.required ? t('docs.required') : null].filter(Boolean).join(' · ')}
          </span>
          {doc.description && <span className="var-preview-doc-description">{doc.description}</span>}
        </div>
      )}
      <div className="var-preview-body">{renderBody()}</div>
    </div>
  )
}
