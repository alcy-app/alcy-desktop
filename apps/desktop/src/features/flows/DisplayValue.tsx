import { useMemo } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { MarkdownView } from '../notifications/MarkdownView'
import { formatResponseText } from '../request-workbench/response-text-format'
import type { DisplayFormat } from './display-format'
import { OutputTree } from './OutputTree'

/** Values are already redacted and bounded by the backend; partial body pages stay readable as text. */
export function DisplayValue({ value, format = 'auto', compact = false, partial = false }: { value: string; format?: DisplayFormat; compact?: boolean; partial?: boolean }) {
  const { t, language } = useLanguage()
  const json = useMemo(() => {
    if (!['auto', 'json', 'number', 'boolean'].includes(format) || partial || value.length > 64 * 1024) return { valid: false, value: undefined as unknown }
    try { return { valid: true, value: JSON.parse(value) as unknown } } catch { return { valid: false, value: undefined as unknown } }
  }, [value, format, partial])
  const detected = format === 'auto' ? json.valid ? typeof json.value === 'number' ? 'number' : typeof json.value === 'boolean' ? 'boolean' : 'json' : 'text' : format
  const code = useMemo(() => {
    if (detected === 'json') return formatResponseText(value, 'json', partial)
    if (detected === 'xml') return formatResponseText(value, 'xml', partial)
    return value
  }, [value, detected, partial])
  const date = detected === 'dateTime' && value.trim() ? new Date(value.trim()) : null
  const valid = detected === 'json' ? json.valid || partial
    : detected === 'number' ? json.valid && typeof json.value === 'number'
      : detected === 'boolean' ? json.valid && typeof json.value === 'boolean'
        : detected === 'dateTime' ? date !== null && Number.isFinite(date.getTime()) : true
  return <div className={`flow-display-value${compact ? ' flow-display-value--compact' : ''}`}>
    {!valid && <p className="flow-data-notice" role="status">{t(detected === 'json' ? 'flows.studio.displayInvalid' : 'flows.studio.displayTypeInvalid')}</p>}
    {detected === 'html' && !partial ? <iframe className="flow-display-html" srcDoc={value} sandbox="" referrerPolicy="no-referrer" title={t('response.bodyPreviewTitle')} />
      : detected === 'markdown' && !partial ? <MarkdownView source={value} />
        : detected === 'number' && valid ? <output className="flow-display-scalar">{new Intl.NumberFormat(language, { maximumFractionDigits: 20 }).format(json.value as number)}</output>
          : detected === 'boolean' && valid ? <output className="flow-display-scalar">{String(json.value)}</output>
            : detected === 'dateTime' && valid ? <time className="flow-display-scalar" dateTime={date!.toISOString()}>{date!.toLocaleString(language)}</time>
              : detected === 'json' && json.valid ? <OutputTree roots={[{ key: 'body', path: 'result', value: json.value }]} selectedPath={null} onSelect={() => undefined} />
                : <pre className="flow-data-text">{code || t('common.empty')}</pre>}
  </div>
}
