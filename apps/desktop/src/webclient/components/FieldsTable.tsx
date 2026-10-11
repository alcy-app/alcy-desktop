import { t } from '../i18n'
import type { Field } from '../types'

interface FieldsTableProps {
  label: string
  fields: Field[]
  onChange: (fields: Field[]) => void
  /** Sem a coluna "ativo" (parâmetros de rota). */
  withoutToggle?: boolean
  /** Rótulo do botão que acrescenta uma linha; sem ele, não há botão. */
  addLabel?: string
}

export function FieldsTable({ label, fields, onChange, withoutToggle, addLabel }: FieldsTableProps) {
  const update = (index: number, patch: Partial<Field>) =>
    onChange(fields.map((field, current) => (current === index ? { ...field, ...patch } : field)))

  return (
    <div className="wc-fields">
      <table className="wc-fields__table" aria-label={label}>
        <thead>
          <tr>
            {!withoutToggle && <th className="wc-fields__toggle">{t('editor.enabled')}</th>}
            <th>{t('editor.name')}</th>
            <th>{t('editor.value')}</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field, index) => (
            <tr key={index}>
              {!withoutToggle && (
                <td className="wc-fields__toggle">
                  <input
                    type="checkbox"
                    checked={field.enabled}
                    aria-label={`${t('editor.enabled')}: ${field.name}`}
                    onChange={(event) => update(index, { enabled: event.target.checked })}
                  />
                </td>
              )}
              <td>
                <input
                  className="wc-input wc-input--mono"
                  value={field.name}
                  aria-label={t('editor.name')}
                  onChange={(event) => update(index, { name: event.target.value })}
                />
              </td>
              <td>
                <input
                  className="wc-input wc-input--mono"
                  value={field.value}
                  aria-label={`${t('editor.value')}: ${field.name}`}
                  onChange={(event) => update(index, { value: event.target.value })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {addLabel && (
        <button type="button" className="wc-button wc-button--ghost" onClick={() => onChange([...fields, { name: '', value: '', enabled: true }])}>
          {addLabel}
        </button>
      )}
    </div>
  )
}
