import type { TranslationKey } from '../../shared/i18n/translations'

export const DISPLAY_FORMATS = ['auto', 'json', 'text', 'number', 'boolean', 'dateTime', 'xml', 'html', 'markdown'] as const
export type DisplayFormat = typeof DISPLAY_FORMATS[number]

export const DISPLAY_FORMAT_LABELS: Record<DisplayFormat, TranslationKey> = {
  auto: 'flows.canvas.displayFormat.auto',
  json: 'flows.canvas.displayFormat.json',
  text: 'flows.canvas.displayFormat.text',
  number: 'flows.canvas.displayFormat.number',
  boolean: 'flows.canvas.displayFormat.boolean',
  dateTime: 'flows.canvas.displayFormat.dateTime',
  xml: 'flows.canvas.displayFormat.xml',
  html: 'flows.canvas.displayFormat.html',
  markdown: 'flows.canvas.displayFormat.markdown',
}

export const isDisplayFormat = (value: unknown): value is DisplayFormat => DISPLAY_FORMATS.some((format) => format === value)
