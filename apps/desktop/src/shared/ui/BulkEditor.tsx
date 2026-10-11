import { useLanguage } from '../i18n/use-language'
import { Textarea } from './Textarea'
import './bulk-edit.css'

interface BulkEditorProps {
  value: string
  onChange: (value: string) => void
  ariaLabel: string
  /** Mostra a dica do prefixo `//` (linhas desativadas). Padrão: `true`. */
  supportsDisabled?: boolean
}

export function BulkEditor({ value, onChange, ariaLabel, supportsDisabled = true }: BulkEditorProps) {
  const { t } = useLanguage()
  return (
    <div className="ui-bulk-editor">
      <Textarea
        mono
        className="ui-bulk-editor-textarea"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={ariaLabel}
        placeholder={t('bulk.placeholder')}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
      />
      <p className="ui-bulk-editor-hint">{supportsDisabled ? t('bulk.hintWithDisabled') : t('bulk.hint')}</p>
    </div>
  )
}
