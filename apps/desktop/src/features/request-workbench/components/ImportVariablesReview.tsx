import { useId } from 'react'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Badge } from '../../../shared/ui/Badge'
import { Checkbox } from '../../../shared/ui/Checkbox'
import { Field } from '../../../shared/ui/Field'
import { Input } from '../../../shared/ui/Input'
import { Select } from '../../../shared/ui/Select'
import { Tooltip } from '../../../shared/ui/Tooltip'
import {
  NEW_ENVIRONMENT_DESTINATION,
  importVariableErrors,
  isCollectionDestination,
  needsNewEnvironment,
  renameImportVariable,
  updateImportVariable,
  type ExistingEnvironmentTarget,
  type ImportVariableError,
  type ImportVariableRow,
  type ImportVariablesState,
} from '../import-variables'
import { VirtualizedList } from './VirtualizedList'

interface ImportVariablesReviewProps {
  state: ImportVariablesState
  environmentNames: string[]
  collectionNames: string[]
  existingEnvironments: ExistingEnvironmentTarget[]
  onChange: (state: ImportVariablesState) => void
}

const ERROR_KEYS = {
  empty: 'collections.importVariablesErrorEmpty',
  invalid: 'collections.importVariablesErrorInvalid',
  duplicate: 'collections.importVariablesErrorDuplicate',
} as const satisfies Record<ImportVariableError, string>

const rowKey = (row: ImportVariableRow) => row.key

export function ImportVariablesReview({
  state,
  environmentNames,
  collectionNames,
  existingEnvironments,
  onChange,
}: ImportVariablesReviewProps) {
  const { t } = useLanguage()
  const fieldId = useId()
  const errors = importVariableErrors(state)
  const newEnvironmentLabel = state.newEnvironmentName.trim() || t('collections.importVariablesNewEnvironmentName')

  const hint = (row: ImportVariableRow): string | null => {
    const error = errors.get(row.key)
    if (error) return t(ERROR_KEYS[error])
    if (row.include && row.destination.startsWith('existing:')) {
      const environment = existingEnvironments.find((candidate) => `existing:${candidate.id}` === row.destination)
      if (environment?.variableNames.includes(row.name.trim())) return t('collections.importVariablesReplaces', { environment: environment.name })
    }
    if (row.valueTruncated) return t('collections.importVariablesTruncated')
    return null
  }

  const renderRow = (row: ImportVariableRow) => {
    const collectionTarget = isCollectionDestination(row.destination)
    const rowHint = hint(row)
    const hasError = errors.has(row.key)
    const sensitiveToggle = (
      <label className="import-variables-sensitive">
        <Checkbox
          checked={row.sensitive && !collectionTarget}
          disabled={!row.include || collectionTarget}
          onChange={(event) => onChange(updateImportVariable(state, row.key, { sensitive: event.target.checked }))}
        />
        <span>{t('collections.importVariablesSensitive')}</span>
      </label>
    )
    return (
      <div className={row.include ? 'import-variables-row' : 'import-variables-row import-variables-row--excluded'}>
        <Checkbox
          checked={row.include}
          aria-label={t('collections.importVariablesInclude', { name: row.originalName })}
          onChange={(event) => onChange(updateImportVariable(state, row.key, { include: event.target.checked }))}
        />
        <div className="import-variables-name">
          <Input
            mono
            value={row.name}
            aria-label={t('common.name')}
            aria-invalid={hasError}
            disabled={!row.include}
            onChange={(event) => onChange(renameImportVariable(state, row.key, event.target.value))}
          />
          {row.referenced && <Badge tone="info" className="import-variables-badge">{t('collections.importVariablesReferenced')}</Badge>}
        </div>
        <Input
          mono
          type={row.sensitive && !collectionTarget ? 'password' : 'text'}
          value={row.value}
          aria-label={t('common.value')}
          readOnly={row.valueTruncated}
          disabled={!row.include}
          onChange={(event) => onChange(updateImportVariable(state, row.key, { value: event.target.value }))}
        />
        <Select
          value={row.destination}
          aria-label={t('collections.importVariablesDestination')}
          disabled={!row.include}
          onChange={(event) => onChange(updateImportVariable(state, row.key, { destination: event.target.value }))}
        >
          <optgroup label={t('collections.importVariablesFileEnvironments')}>
            {environmentNames.map((name, index) => <option key={`imported:${index}`} value={`imported:${index}`}>{name}</option>)}
            <option value={NEW_ENVIRONMENT_DESTINATION}>{t('collections.importVariablesNewEnvironment', { name: newEnvironmentLabel })}</option>
          </optgroup>
          {existingEnvironments.length > 0 && (
            <optgroup label={t('collections.importVariablesWorkspaceEnvironments')}>
              {existingEnvironments.map((environment) => <option key={environment.id} value={`existing:${environment.id}`}>{environment.name}</option>)}
            </optgroup>
          )}
          {collectionNames.length > 0 && (
            <optgroup label={t('collections.importVariablesCollections')}>
              {collectionNames.map((name, index) => <option key={`collection:${index}`} value={`collection:${index}`}>{name}</option>)}
            </optgroup>
          )}
        </Select>
        {collectionTarget ? (
          // The host span receives hover even though the checkbox is disabled.
          <Tooltip label={t('collections.importVariablesCollectionNotSensitive')} side="left" multiline>
            {sensitiveToggle}
          </Tooltip>
        ) : (
          sensitiveToggle
        )}
        {rowHint && <p className={hasError ? 'import-variables-hint import-variables-hint--error' : 'import-variables-hint'}>{rowHint}</p>}
      </div>
    )
  }

  const environmentNameMissing = needsNewEnvironment(state) && state.newEnvironmentName.trim() === ''

  return (
    <div className="import-variables">
      {needsNewEnvironment(state) && (
        <Field label={t('collections.importVariablesNewEnvironmentName')} htmlFor={`${fieldId}-environment`} error={environmentNameMissing ? t('collections.importVariablesErrorEnvironmentName') : undefined}>
          <Input id={`${fieldId}-environment`} value={state.newEnvironmentName} aria-invalid={environmentNameMissing} onChange={(event) => onChange({ ...state, newEnvironmentName: event.target.value })} />
        </Field>
      )}
      <div className="import-variables-header" aria-hidden="true">
        <span />
        <span>{t('common.name')}</span>
        <span>{t('common.value')}</span>
        <span>{t('collections.importVariablesDestination')}</span>
        <span />
      </div>
      <VirtualizedList
        items={state.rows}
        getKey={rowKey}
        estimatedRowHeight={40}
        renderItem={renderRow}
        className="import-variables-list"
        ariaLabel={t('collections.importVariablesListLabel')}
      />
    </div>
  )
}
