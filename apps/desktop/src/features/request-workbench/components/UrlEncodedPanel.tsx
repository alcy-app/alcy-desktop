import { useState } from 'react'
import { parseBulk, serializeBulk, type BulkRow } from '../../../shared/bulk-edit'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import { useLanguage } from '../../../shared/i18n/use-language'
import { BulkEditor } from '../../../shared/ui/BulkEditor'
import { BulkEditToggle } from '../../../shared/ui/BulkEditToggle'
import { Button } from '../../../shared/ui/Button'
import { Checkbox } from '../../../shared/ui/Checkbox'
import { IconButton } from '../../../shared/ui/IconButton'
import { PlusIcon, TrashIcon } from '../../../shared/ui/icons'
import type { UrlEncodedEntry } from '../request-workbench.types'
import { TemplateHighlightedField } from './TemplateHighlightedField'

interface UrlEncodedPanelProps {
  fields: UrlEncodedEntry[]
  onAdd: () => void
  onUpdate: (id: string, patch: Partial<Omit<UrlEncodedEntry, 'id'>>) => void
  onRemove: (id: string) => void
  /** Variáveis do ambiente ativo — destaque, tooltip e sugestões de `{{variável}}` nos campos interpolados. */
  environmentVariables: EnvironmentVariableDto[]
  onReplaceAll: (rows: BulkRow[]) => void
}

/** Pares chave-valor de um corpo x-www-form-urlencoded — mesma grade (e
 * edição em massa) de Headers/Params. */
export function UrlEncodedPanel({
  fields,
  onAdd,
  onUpdate,
  onRemove,
  onReplaceAll,
  environmentVariables,
}: UrlEncodedPanelProps) {
  const { t } = useLanguage()
  // `null` = tabela; string = texto em edição (rascunho local, aplicado a cada alteração).
  const [bulkText, setBulkText] = useState<string | null>(null)
  return (
    <div className="rw-body-fields">
      <BulkEditToggle bulk={bulkText !== null} onChange={(bulk) => setBulkText(bulk ? serializeBulk(fields) : null)} />
      {bulkText !== null ? (
        <BulkEditor
          value={bulkText}
          ariaLabel={t('bulk.urlEncodedAria')}
          onChange={(text) => {
            setBulkText(text)
            onReplaceAll(parseBulk(text))
          }}
        />
      ) : (
        <>
          <table className="rw-headers-table rw-headers-table--grid">
            <caption className="rw-visually-hidden">{t('requestBody.urlEncodedCaption')}</caption>
            <colgroup>
              <col style={{ width: '36px' }} />
              <col />
              <col />
              <col style={{ width: '44px' }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">
                  <span className="rw-visually-hidden">{t('requestBody.enabledColumn')}</span>
                </th>
                <th scope="col">{t('common.name')}</th>
                <th scope="col">{t('common.value')}</th>
                <th scope="col">
                  <span className="rw-visually-hidden">{t('common.remove')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {fields.map((field) => (
                <tr key={field.id}>
                  <td>
                    <label className="rw-visually-hidden" htmlFor={`urlencoded-enabled-${field.id}`}>
                      {t('requestBody.enableAria', { name: field.name || t('common.unnamed') })}
                    </label>
                    <Checkbox
                      id={`urlencoded-enabled-${field.id}`}
                      checked={field.enabled}
                      onChange={(event) => onUpdate(field.id, { enabled: event.target.checked })}
                    />
                  </td>
                  <td>
                    <label className="rw-visually-hidden" htmlFor={`urlencoded-name-${field.id}`}>
                      {t('requestBody.nameFieldLabel')}
                    </label>
                    <TemplateHighlightedField
                      id={`urlencoded-name-${field.id}`}
                      fieldClassName="ui-input"
                      value={field.name}
                      onChange={(name) => onUpdate(field.id, { name })}
                      variables={environmentVariables}
                      placeholder={t('common.name')}
                    />
                  </td>
                  <td>
                    <label className="rw-visually-hidden" htmlFor={`urlencoded-value-${field.id}`}>
                      {t('requestBody.valueFieldLabel')}
                    </label>
                    <TemplateHighlightedField
                      id={`urlencoded-value-${field.id}`}
                      fieldClassName="ui-input"
                      value={field.value}
                      onChange={(value) => onUpdate(field.id, { value })}
                      variables={environmentVariables}
                      placeholder={t('common.value')}
                    />
                  </td>
                  <td>
                    <IconButton
                      variant="danger"
                      icon={<TrashIcon size={13} />}
                      label={t('requestBody.removeAria', { name: field.name || t('common.unnamed') })}
                      onClick={() => onRemove(field.id)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Button variant="ghost" onClick={onAdd}>
            <PlusIcon size={12} />
            {t('requestBody.addField')}
          </Button>
        </>
      )}
    </div>
  )
}
