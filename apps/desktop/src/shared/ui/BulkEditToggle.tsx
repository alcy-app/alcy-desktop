import { useLanguage } from '../i18n/use-language'
import { Button } from './Button'
import './bulk-edit.css'

interface BulkEditToggleProps {
  bulk: boolean
  onChange: (bulk: boolean) => void
}

/** Toggles bulk (text) editing; when off, the key-value table is shown. */
export function BulkEditToggle({ bulk, onChange }: BulkEditToggleProps) {
  const { t } = useLanguage()
  return (
    <div className="ui-bulk-toolbar">
      <Button variant="ghost" size="sm" aria-pressed={bulk} onClick={() => onChange(!bulk)}>
        {t('bulk.bulkEdit')}
      </Button>
    </div>
  )
}
