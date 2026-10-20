import { useMemo } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { OutputTree } from './OutputTree'

export function DisplayValue({ value, format = 'auto', compact = false }: { value: string; format?: 'auto' | 'json' | 'text'; compact?: boolean }) {
  const { t } = useLanguage()
  const json = useMemo(() => {
    if (format === 'text' || value.length > 64 * 1024) return { valid: false, value: undefined as unknown }
    try { return { valid: true, value: JSON.parse(value) as unknown } } catch { return { valid: false, value: undefined as unknown } }
  }, [value, format])
  if (compact) return <pre className="flow-node-display-value nodrag">{(format !== 'text' && json.valid ? JSON.stringify(json.value, null, 2) : value).slice(0, 500) || t('common.empty')}</pre>
  return <div className="flow-display-value">
    {format === 'json' && !json.valid && <p className="flow-data-notice">{t('flows.studio.displayInvalid')}</p>}
    {format !== 'text' && json.valid ? <OutputTree roots={[{ key: 'result', path: 'result', value: json.value }]} selectedPath={null} onSelect={() => undefined} /> : <pre className="flow-data-text">{value || t('common.empty')}</pre>}
  </div>
}
