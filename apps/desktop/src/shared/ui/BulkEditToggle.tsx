import { useLanguage } from '../i18n/use-language'
import { SegmentedControl } from './SegmentedControl'
import './bulk-edit.css'

interface BulkEditToggleProps {
  bulk: boolean
  onChange: (bulk: boolean) => void
}

type BulkMode = 'table' | 'bulk'

/** Alterna entre a tabela chave-valor e a edição em massa (texto). */
export function BulkEditToggle({ bulk, onChange }: BulkEditToggleProps) {
  const { t } = useLanguage()
  return (
    <div className="ui-bulk-toolbar">
      <SegmentedControl<BulkMode>
        layout="inline"
        size="sm"
        ariaLabel={t('bulk.modeAria')}
        value={bulk ? 'bulk' : 'table'}
        onChange={(mode) => onChange(mode === 'bulk')}
        options={[
          { value: 'table', label: t('bulk.keyValue') },
          { value: 'bulk', label: t('bulk.bulkEdit') },
        ]}
      />
    </div>
  )
}
