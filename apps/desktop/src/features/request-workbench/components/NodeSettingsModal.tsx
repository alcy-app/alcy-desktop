import { useId, useMemo, useState } from 'react'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { Field } from '../../../shared/ui/Field'
import { IconButton } from '../../../shared/ui/IconButton'
import { InlineEditInput } from '../../../shared/ui/InlineEditInput'
import { Input } from '../../../shared/ui/Input'
import { Modal } from '../../../shared/ui/Modal'
import { PlusIcon, TrashIcon } from '../../../shared/ui/icons'
import type { AuthenticationInput } from '../../../bindings/execute-graphql-request'
import type { ScopedVariableDto } from '../../../bindings/list-collections'
import { toAuthenticationInput, toAuthorizationState } from '../authorization-state'
import type { EffectiveVariable, VariableSource } from '../collection-tree'
import type { AuthorizationState } from '../request-workbench.types'
import { VariableEditingContext, useVariableEditing } from '../variable-editing-context'
import type { VariableEditing } from '../variable-editing-context'
import { AuthorizationPanel } from './AuthorizationPanel'
import './node-settings-modal.css'

interface NodeSettingsModalProps {
  kind: 'collection' | 'folder'
  nodeId: string
  name: string
  authentication: AuthenticationInput
  variables: ScopedVariableDto[]
  /** Variáveis vigentes acima desta coleção/pasta (ambiente ativo e ancestores) — destaque e sugestões de
   * `{{variável}}` nos campos de autenticação, junto com as variáveis em edição aqui. */
  environmentVariables: EffectiveVariable[]
  onSave: (settings: { name: string; authentication: AuthenticationInput; variables: ScopedVariableDto[] }) => void
  onClose: () => void
}

interface VariableDraft {
  id: string
  name: string
  value: string
}

type VariablesError = { kind: 'emptyName' } | { kind: 'invalidName' | 'duplicate'; name: string } | null

/** Mesmas regras do backend (`EnvironmentVariable::new` e nomes únicos por escopo); linhas totalmente vazias são
 * ignoradas. */
function validateVariables(rows: VariableDraft[]): VariablesError {
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.name.trim() === '') {
      if (row.value !== '') return { kind: 'emptyName' }
      continue
    }
    if (row.name.includes('{') || row.name.includes('}')) return { kind: 'invalidName', name: row.name }
    if (seen.has(row.name)) return { kind: 'duplicate', name: row.name }
    seen.add(row.name)
  }
  return null
}

function toDrafts(variables: ScopedVariableDto[]): VariableDraft[] {
  return variables.map((variable) => ({ id: crypto.randomUUID(), ...variable }))
}

/** Gerencia uma coleção ou pasta: nome, a autenticação herdada pelas requisições e pastas filhas que usam "herdar"
 * e as variáveis de escopo local (ADR 0031). */
export function NodeSettingsModal({
  kind,
  nodeId,
  name,
  authentication,
  variables,
  environmentVariables,
  onSave,
  onClose,
}: NodeSettingsModalProps) {
  const { t } = useLanguage()
  const fieldId = useId()
  const [draftName, setDraftName] = useState(name)
  const [authorization, setAuthorization] = useState<AuthorizationState>(() => toAuthorizationState(authentication))
  const [variableRows, setVariableRows] = useState<VariableDraft[]>(() => toDrafts(variables))
  const variablesError = validateVariables(variableRows)
  const canSave = draftName.trim().length > 0 && variablesError === null

  const updateRow = (id: string, patch: Partial<Omit<VariableDraft, 'id'>>) =>
    setVariableRows((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))

  // As variáveis em edição valem nos campos de autenticação daqui, com a origem nesta coleção/pasta.
  const draftSource = useMemo<VariableSource>(() => ({ nodeId, kind, name: draftName }), [nodeId, kind, draftName])
  const fieldVariables = useMemo(() => {
    const merged = new Map<string, EffectiveVariable>(environmentVariables.map((variable) => [variable.name, variable]))
    for (const row of variableRows) {
      if (row.name.trim() !== '') merged.set(row.name, { name: row.name, value: row.value, sensitive: false, source: draftSource })
    }
    return [...merged.values()]
  }, [environmentVariables, variableRows, draftSource])

  // Editar pelo cartão de hover uma variável desta coleção/pasta altera o rascunho (gravado só ao salvar); as demais
  // seguem para o ambiente ou para o ancestral que as define.
  const outerEditing = useVariableEditing()
  const editing = useMemo<VariableEditing | null>(() => {
    if (!outerEditing) return null
    return {
      canCreate: outerEditing.canCreate,
      setValue: (variableName, value, source) => {
        if (source?.nodeId !== nodeId) {
          outerEditing.setValue(variableName, value, source)
          return
        }
        setVariableRows((rows) => rows.map((row) => (row.name === variableName ? { ...row, value } : row)))
      },
    }
  }, [outerEditing, nodeId])

  const submit = () => {
    if (!canSave) return
    onSave({
      name: draftName.trim(),
      authentication: toAuthenticationInput(authorization),
      variables: variableRows.filter((row) => row.name.trim() !== '').map(({ name: variableName, value }) => ({ name: variableName, value })),
    })
    onClose()
  }

  const errorMessage =
    variablesError === null
      ? null
      : variablesError.kind === 'emptyName'
        ? t('collections.manageVariablesEmptyName')
        : t(variablesError.kind === 'duplicate' ? 'collections.manageVariablesDuplicate' : 'collections.manageVariablesInvalidName', {
            name: variablesError.name,
          })

  return (
    <Modal
      title={t(kind === 'collection' ? 'collections.manageCollectionModalTitle' : 'collections.manageFolderModalTitle')}
      closeAriaLabel={t('collections.closeModalAria')}
      onClose={onClose}
      className="ui-modal--form ui-modal--md node-settings-modal"
    >
      {(requestClose) => (
        <VariableEditingContext value={editing}>
          <Field label={t('common.name')} htmlFor={`${fieldId}-name`}>
            <Input
              id={`${fieldId}-name`}
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit()
              }}
              autoFocus
            />
          </Field>

          <section className="node-settings-section">
            <h3 className="node-settings-section-title">{t('collections.manageAuthenticationSection')}</h3>
            <p className="ui-modal-description">{t('collections.manageAuthenticationDescription')}</p>
            <AuthorizationPanel
              idPrefix="node-authorization"
              authorization={authorization}
              onChange={(patch) => setAuthorization((current) => ({ ...current, ...patch }))}
              environmentVariables={fieldVariables}
            />
          </section>

          <section className="node-settings-section">
            <h3 className="node-settings-section-title">{t('collections.manageVariablesSection')}</h3>
            <p className="ui-modal-description">{t('collections.manageVariablesDescription')}</p>
            {variableRows.length > 0 && (
              <table className="node-variables-table">
                <thead>
                  <tr>
                    <th scope="col">{t('environments.variableColumn')}</th>
                    <th scope="col">{t('common.value')}</th>
                    <th scope="col">
                      <span className="rw-visually-hidden">{t('common.remove')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {variableRows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <label className="rw-visually-hidden" htmlFor={`${fieldId}-var-name-${row.id}`}>
                          {t('environments.variableNameLabel')}
                        </label>
                        <InlineEditInput
                          id={`${fieldId}-var-name-${row.id}`}
                          value={row.name}
                          onChange={(event) => updateRow(row.id, { name: event.target.value })}
                          placeholder={t('environments.namePlaceholder')}
                        />
                      </td>
                      <td>
                        <label className="rw-visually-hidden" htmlFor={`${fieldId}-var-value-${row.id}`}>
                          {t('environments.variableValueLabel')}
                        </label>
                        <InlineEditInput
                          id={`${fieldId}-var-value-${row.id}`}
                          value={row.value}
                          onChange={(event) => updateRow(row.id, { value: event.target.value })}
                          placeholder={t('environments.valuePlaceholder')}
                        />
                      </td>
                      <td>
                        <IconButton
                          icon={<TrashIcon size={13} />}
                          label={t('environments.removeVariableAria', { name: row.name || t('common.unnamed') })}
                          onClick={() => setVariableRows((rows) => rows.filter((candidate) => candidate.id !== row.id))}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {errorMessage && (
              <p className="node-settings-error" role="alert">
                {errorMessage}
              </p>
            )}
            <div>
              <Button
                variant="ghost"
                onClick={() => setVariableRows((rows) => [...rows, { id: crypto.randomUUID(), name: '', value: '' }])}
              >
                <PlusIcon size={12} />
                {t('environments.addVariableButton')}
              </Button>
            </div>
          </section>

          <div className="ui-modal-actions">
            <Button variant="ghost" onClick={requestClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={submit} disabled={!canSave}>
              {t('collections.manageSaveButton')}
            </Button>
          </div>
        </VariableEditingContext>
      )}
    </Modal>
  )
}
