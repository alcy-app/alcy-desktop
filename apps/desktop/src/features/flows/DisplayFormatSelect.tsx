import { useLanguage } from '../../shared/i18n/use-language'
import { Select } from '../../shared/ui/Select'
import { DISPLAY_FORMAT_LABELS, DISPLAY_FORMATS, isDisplayFormat } from './display-format'
import type { DisplayFormat } from './display-format'

export function DisplayFormatSelect({ value, onChange }: { value: DisplayFormat; onChange?: (format: DisplayFormat) => void }) {
  const { t } = useLanguage()
  return <span className="flow-display-format nodrag nopan" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    <Select aria-label={t('flows.studio.displayFormat')} value={value} onChange={(event) => { if (isDisplayFormat(event.target.value)) onChange?.(event.target.value) }}>
      {DISPLAY_FORMATS.map((format) => <option key={format} value={format}>{t(DISPLAY_FORMAT_LABELS[format])}</option>)}
    </Select>
  </span>
}
