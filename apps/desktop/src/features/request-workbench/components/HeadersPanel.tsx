import { memo, useMemo, useState } from 'react'
import { parseBulk, serializeBulk, type BulkRow } from '../../../shared/bulk-edit'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import { useLanguage } from '../../../shared/i18n/use-language'
import { BulkEditor } from '../../../shared/ui/BulkEditor'
import { BulkEditToggle } from '../../../shared/ui/BulkEditToggle'
import { Button } from '../../../shared/ui/Button'
import { Checkbox } from '../../../shared/ui/Checkbox'
import { IconButton } from '../../../shared/ui/IconButton'
import { Input } from '../../../shared/ui/Input'
import { EyeIcon, EyeOffIcon, PlusIcon, TrashIcon } from '../../../shared/ui/icons'
import { useTooltip } from '../../../shared/ui/use-tooltip'
import type { HeaderEntry } from '../request-workbench.types'
import type { FieldSuggestion } from '../schema-completions'
import { TemplateHighlightedField } from './TemplateHighlightedField'

export interface GeneratedHeaderEntry {
  name: string
  value: string
  /** Motivo exibido no tooltip; sem ele vale o texto da autenticação. */
  reason?: string
}

interface HeadersPanelProps {
  headers: HeaderEntry[]
  onAdd: () => void
  onUpdate: (id: string, patch: Partial<Omit<HeaderEntry, 'id'>>) => void
  onRemove: (id: string) => void
  /** Variáveis do ambiente ativo: destaque, tooltip e sugestões nos campos interpolados. */
  environmentVariables: EnvironmentVariableDto[]
  onReplaceAll: (rows: BulkRow[]) => void
  /** Nomes documentados (documentação importada); ausente = sem sugestões. */
  nameSuggestions?: FieldSuggestion[]
  /** Valores conhecidos do header de nome informado. */
  valueSuggestionsFor?: (name: string) => FieldSuggestion[]
  /** Headers automáticos gerados pela autenticação efetiva. Não são editáveis nem entram na edição em massa. */
  generatedHeaders?: GeneratedHeaderEntry[]
  /** Headers manuais que serão substituídos pela autenticação efetiva no envio. */
  overwrittenHeaderNames?: string[]
  /** Cookies guardados na sessão; com `onOpenSessionCookies`, mostra o botão que abre a lista. */
  sessionCookieCount?: number
  onOpenSessionCookies?: () => void
}

interface HeaderRowProps {
  header: HeaderEntry
  duplicate: boolean
  duplicateReason: string
  onUpdate: (id: string, patch: Partial<Omit<HeaderEntry, 'id'>>) => void
  onRemove: (id: string) => void
  environmentVariables: EnvironmentVariableDto[]
  nameSuggestions?: FieldSuggestion[]
  valueSuggestionsFor?: (name: string) => FieldSuggestion[]
}

const HeaderRow = memo(function HeaderRow({
  header,
  duplicate,
  duplicateReason,
  onUpdate,
  onRemove,
  environmentVariables,
  nameSuggestions,
  valueSuggestionsFor,
}: HeaderRowProps) {
  const { t } = useLanguage()
  const { triggerProps, tooltip } = useTooltip(duplicateReason, { side: 'top', multiline: true, enabled: duplicate })
  return (
    <tr className={duplicate ? 'rw-header-row--duplicate' : undefined} {...triggerProps}>
      <td>
        <label className="rw-visually-hidden" htmlFor={`header-enabled-${header.id}`}>
          {t('headers.enableAria', { name: header.name || t('common.unnamed') })}
        </label>
        <Checkbox
          id={`header-enabled-${header.id}`}
          checked={header.enabled}
          onChange={(event) => onUpdate(header.id, { enabled: event.target.checked })}
        />
      </td>
      <td>
        <label className="rw-visually-hidden" htmlFor={`header-name-${header.id}`}>
          {t('headers.nameFieldLabel')}
        </label>
        {nameSuggestions ? (
          <TemplateHighlightedField
            id={`header-name-${header.id}`}
            fieldClassName="ui-input"
            value={header.name}
            onChange={(name) => onUpdate(header.id, { name })}
            variables={environmentVariables}
            placeholder={t('common.name')}
            suggestions={nameSuggestions}
            templates={false}
          />
        ) : (
          <Input
            id={`header-name-${header.id}`}
            value={header.name}
            onChange={(event) => onUpdate(header.id, { name: event.target.value })}
            placeholder={t('common.name')}
            spellCheck={false}
            autoComplete="off"
          />
        )}
      </td>
      <td>
        <label className="rw-visually-hidden" htmlFor={`header-value-${header.id}`}>
          {t('headers.valueFieldLabel')}
        </label>
        <TemplateHighlightedField
          id={`header-value-${header.id}`}
          fieldClassName="ui-input"
          value={header.value}
          onChange={(value) => onUpdate(header.id, { value })}
          variables={environmentVariables}
          placeholder={t('common.value')}
          suggestions={valueSuggestionsFor?.(header.name)}
        />
      </td>
      <td>
        <IconButton
          variant="danger"
          icon={<TrashIcon size={13} />}
          label={t('headers.removeAria', { name: header.name || t('common.unnamed') })}
          onClick={() => onRemove(header.id)}
        />
      </td>
      {tooltip}
    </tr>
  )
})

interface GeneratedHeaderRowProps {
  header: GeneratedHeaderEntry
  reason: string
}

const GeneratedHeaderRow = memo(function GeneratedHeaderRow({ header, reason }: GeneratedHeaderRowProps) {
  const { t } = useLanguage()
  const { triggerProps, tooltip } = useTooltip(reason, { side: 'top', multiline: true })
  return (
    <tr className="rw-header-row--generated" aria-readonly="true" {...triggerProps}>
      <td>
        <Checkbox aria-label={t('headers.generatedEnableAria', { name: header.name })} checked disabled />
      </td>
      <td>
        <span className="rw-generated-header-field" aria-label={t('headers.nameFieldLabel')}>
          {header.name}
        </span>
      </td>
      <td>
        <span className="rw-generated-header-field" aria-label={t('headers.valueFieldLabel')}>
          {header.value}
        </span>
      </td>
      <td className="rw-generated-header-actions">{t('headers.generatedBadge')}</td>
      {tooltip}
    </tr>
  )
})

export const HeadersPanel = memo(function HeadersPanel({
  headers,
  onAdd,
  onUpdate,
  onRemove,
  onReplaceAll,
  environmentVariables,
  nameSuggestions,
  valueSuggestionsFor,
  generatedHeaders = [],
  overwrittenHeaderNames = [],
  sessionCookieCount = 0,
  onOpenSessionCookies,
}: HeadersPanelProps) {
  const { t } = useLanguage()
  // null = tabela; string = texto em edição (rascunho local, aplicado a cada alteração).
  const [bulkText, setBulkText] = useState<string | null>(null)
  const [showGeneratedHeaders, setShowGeneratedHeaders] = useState(false)
  const overwrittenHeaderNameSet = useMemo(
    () => new Set(overwrittenHeaderNames.map((name) => name.trim().toLowerCase()).filter(Boolean)),
    [overwrittenHeaderNames],
  )
  const generatedCount = generatedHeaders.length
  const visibleGeneratedHeaders = showGeneratedHeaders ? generatedHeaders : []
  return (
    <div className="rw-panel">
      <div className="rw-headers-toolbar">
        {generatedCount > 0 && bulkText === null && (
          <button
            type="button"
            className="rw-generated-headers-toggle"
            onClick={() => setShowGeneratedHeaders((visible) => !visible)}
          >
            {showGeneratedHeaders ? <EyeOffIcon size={12} /> : <EyeIcon size={12} />}
            {showGeneratedHeaders
              ? t('headers.hideGeneratedButton', { count: generatedCount })
              : t('headers.showGeneratedButton', { count: generatedCount })}
          </button>
        )}
        {onOpenSessionCookies && sessionCookieCount > 0 && bulkText === null && (
          <button type="button" className="rw-generated-headers-toggle" onClick={onOpenSessionCookies}>
            {t('sessionCookies.openButton', { count: sessionCookieCount })}
          </button>
        )}
        <BulkEditToggle
          bulk={bulkText !== null}
          onChange={(bulk) => setBulkText(bulk ? serializeBulk(headers) : null)}
        />
      </div>
      {bulkText !== null ? (
        <BulkEditor
          value={bulkText}
          ariaLabel={t('bulk.headersAria')}
          onChange={(text) => {
            setBulkText(text)
            onReplaceAll(parseBulk(text))
          }}
        />
      ) : (
        <>
          <table className="rw-headers-table rw-headers-table--grid">
            <caption className="rw-visually-hidden">{t('headers.caption')}</caption>
            <colgroup>
              <col style={{ width: '36px' }} />
              <col />
              <col />
              <col style={{ width: '72px' }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">
                  <span className="rw-visually-hidden">{t('headers.enabledColumn')}</span>
                </th>
                <th scope="col">{t('common.name')}</th>
                <th scope="col">{t('common.value')}</th>
                <th scope="col">
                  <span className="rw-visually-hidden">{t('common.remove')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleGeneratedHeaders.map((header) => (
                <GeneratedHeaderRow key={header.name.toLowerCase()} header={header} reason={header.reason ?? t('headers.generatedTooltip')} />
              ))}
              {headers.map((header) => {
                const duplicate = header.enabled && overwrittenHeaderNameSet.has(header.name.trim().toLowerCase())
                return (
                  <HeaderRow
                    key={header.id}
                    header={header}
                    duplicate={duplicate}
                    duplicateReason={t('headers.duplicateOverwrittenByAuthorization')}
                    onUpdate={onUpdate}
                    onRemove={onRemove}
                    environmentVariables={environmentVariables}
                    nameSuggestions={nameSuggestions}
                    valueSuggestionsFor={valueSuggestionsFor}
                  />
                )
              })}
            </tbody>
          </table>
          <Button variant="ghost" onClick={onAdd}>
            <PlusIcon size={12} />
            {t('headers.addButton')}
          </Button>
        </>
      )}
    </div>
  )
})
