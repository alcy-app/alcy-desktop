import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { Checkbox } from '../../../shared/ui/Checkbox'
import { IconButton } from '../../../shared/ui/IconButton'
import { CloseIcon, PlusIcon, TrashIcon } from '../../../shared/ui/icons'
import { fileNameOf } from '../body-state'
import type { FormDataEntry } from '../request-workbench.types'
import { BodyFileNotice } from './BodyFileNotice'
import { OptionSelect, type SelectOption } from './OptionSelect'
import { TemplateHighlightedField } from './TemplateHighlightedField'

interface FormDataPanelProps {
  fields: FormDataEntry[]
  onAdd: () => void
  onUpdate: (id: string, patch: Partial<Omit<FormDataEntry, 'id'>>) => void
  onRemove: (id: string) => void
  /** Variáveis do ambiente ativo — destaque, tooltip e sugestões de `{{variável}}` nos campos interpolados. */
  environmentVariables: EnvironmentVariableDto[]
  onPickFile: () => Promise<string | null>
  /** Caminhos de arquivo que não existem nesta máquina. */
  missingFiles: ReadonlySet<string>
}

/** Campos de um corpo multipart/form-data: cada linha é texto ou arquivo.
 * Arquivos guardam só o caminho — o backend lê o conteúdo ao enviar. */
export function FormDataPanel({
  fields,
  onAdd,
  onUpdate,
  onRemove,
  onPickFile,
  missingFiles,
  environmentVariables,
}: FormDataPanelProps) {
  const { t } = useLanguage()
  const kindOptions: SelectOption<FormDataEntry['kind']>[] = [
    { value: 'text', label: t('requestBody.kindText') },
    { value: 'file', label: t('requestBody.kindFile') },
  ]

  const pickFileFor = async (id: string) => {
    const path = await onPickFile()
    if (path) onUpdate(id, { filePath: path })
  }

  return (
    <div className="rw-body-fields">
      <table className="rw-headers-table rw-headers-table--grid">
        <caption className="rw-visually-hidden">{t('requestBody.formDataCaption')}</caption>
        <colgroup>
          <col style={{ width: '36px' }} />
          <col />
          <col style={{ width: '112px' }} />
          <col />
          <col style={{ width: '44px' }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">
              <span className="rw-visually-hidden">{t('requestBody.enabledColumn')}</span>
            </th>
            <th scope="col">{t('common.name')}</th>
            <th scope="col">{t('requestBody.kindColumn')}</th>
            <th scope="col">{t('common.value')}</th>
            <th scope="col">
              <span className="rw-visually-hidden">{t('common.remove')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => {
            const displayName = field.name || t('common.unnamed')
            return (
              <tr key={field.id}>
                <td>
                  <label className="rw-visually-hidden" htmlFor={`form-data-enabled-${field.id}`}>
                    {t('requestBody.enableAria', { name: displayName })}
                  </label>
                  <Checkbox
                    id={`form-data-enabled-${field.id}`}
                    checked={field.enabled}
                    onChange={(event) => onUpdate(field.id, { enabled: event.target.checked })}
                  />
                </td>
                <td>
                  <label className="rw-visually-hidden" htmlFor={`form-data-name-${field.id}`}>
                    {t('requestBody.nameFieldLabel')}
                  </label>
                  <TemplateHighlightedField
                    id={`form-data-name-${field.id}`}
                    fieldClassName="ui-input"
                    value={field.name}
                    onChange={(name) => onUpdate(field.id, { name })}
                    variables={environmentVariables}
                    placeholder={t('common.name')}
                  />
                </td>
                <td>
                  <label className="rw-visually-hidden" htmlFor={`form-data-kind-${field.id}`}>
                    {t('requestBody.kindAria', { name: displayName })}
                  </label>
                  <OptionSelect
                    id={`form-data-kind-${field.id}`}
                    value={field.kind}
                    options={kindOptions}
                    onChange={(kind) => onUpdate(field.id, { kind })}
                  />
                </td>
                <td>
                  {field.kind === 'text' ? (
                    <>
                      <label className="rw-visually-hidden" htmlFor={`form-data-value-${field.id}`}>
                        {t('requestBody.valueFieldLabel')}
                      </label>
                      <TemplateHighlightedField
                        id={`form-data-value-${field.id}`}
                        fieldClassName="ui-input"
                        value={field.value}
                        onChange={(value) => onUpdate(field.id, { value })}
                        variables={environmentVariables}
                        placeholder={t('common.value')}
                      />
                    </>
                  ) : field.filePath ? (
                    <span className="rw-body-file-cell">
                      <span
                        className={
                          missingFiles.has(field.filePath)
                            ? 'rw-body-file-chip rw-body-file-chip--missing'
                            : 'rw-body-file-chip'
                        }
                        title={field.filePath}
                      >
                        <button type="button" className="rw-body-file-chip-name" onClick={() => void pickFileFor(field.id)}>
                          {fileNameOf(field.filePath)}
                        </button>
                        <IconButton
                          icon={<CloseIcon size={11} />}
                          label={t('requestBody.clearFileAria', { name: fileNameOf(field.filePath) })}
                          onClick={() => onUpdate(field.id, { filePath: '' })}
                        />
                      </span>
                      <BodyFileNotice path={field.filePath} missing={missingFiles.has(field.filePath)} />
                    </span>
                  ) : (
                    <Button variant="ghost" className="rw-body-file-pick" onClick={() => void pickFileFor(field.id)}>
                      {t('requestBody.chooseFile')}
                    </Button>
                  )}
                </td>
                <td>
                  <IconButton
                    variant="danger"
                    icon={<TrashIcon size={13} />}
                    label={t('requestBody.removeAria', { name: displayName })}
                    onClick={() => onRemove(field.id)}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <Button variant="ghost" onClick={onAdd}>
        <PlusIcon size={12} />
        {t('requestBody.addField')}
      </Button>
    </div>
  )
}
