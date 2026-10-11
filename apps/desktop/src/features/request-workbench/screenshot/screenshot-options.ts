export type ScreenshotLayout = 'vertical' | 'sideBySide'
export type ScreenshotTheme = 'light' | 'dark'
export type ScreenshotWidth = 'compact' | 'standard' | 'wide'
export type ScreenshotLineLimit = '30' | '60' | '120' | 'all'
export type ScreenshotField =
  | 'header'
  | 'url'
  | 'status'
  | 'requestHeaders'
  | 'requestBody'
  | 'responseHeaders'
  | 'responseBody'

/** Como a imagem de compartilhamento é organizada e o que ela mostra. */
export interface ScreenshotOptions {
  layout: ScreenshotLayout
  theme: ScreenshotTheme
  width: ScreenshotWidth
  lineLimit: ScreenshotLineLimit
  fields: Record<ScreenshotField, boolean>
  hideSensitive: boolean
  /** Embute a requisição no PNG para a imagem poder ser importada no Alcy (ADR 0032). */
  includeImportMetadata: boolean
}

export const SCREENSHOT_FIELDS: ScreenshotField[] = [
  'header',
  'url',
  'status',
  'requestHeaders',
  'requestBody',
  'responseHeaders',
  'responseBody',
]

/** Campos que só existem com uma resposta recebida. */
export const RESPONSE_FIELDS = new Set<ScreenshotField>(['status', 'responseHeaders', 'responseBody'])

/** Largura da imagem em pixels lógicos; a exportação sai em 2x. */
export const SCREENSHOT_WIDTHS: Record<ScreenshotWidth, number> = { compact: 800, standard: 1200, wide: 1600 }

export const DEFAULT_SCREENSHOT_OPTIONS: ScreenshotOptions = {
  layout: 'vertical',
  theme: 'light',
  width: 'standard',
  lineLimit: '60',
  fields: {
    header: true,
    url: true,
    status: true,
    requestHeaders: false,
    requestBody: true,
    responseHeaders: false,
    responseBody: true,
  },
  hideSensitive: true,
  includeImportMetadata: true,
}

/** "Todas" ainda tem um teto, para o destaque de sintaxe e o layout não
 * processarem um corpo gigante que a altura máxima da imagem cortaria. */
const MAX_LINES = 2_000

export function lineLimitValue(limit: ScreenshotLineLimit): number {
  return limit === 'all' ? MAX_LINES : Number(limit)
}

const STORAGE_KEY = 'alcy:share:screenshot'

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Lê as opções salvas campo a campo: um valor inválido ou de uma versão
 * anterior cai no padrão sem descartar o restante. */
export function loadScreenshotOptions(): ScreenshotOptions {
  let stored: Record<string, unknown> = {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object') stored = parsed as Record<string, unknown>
  } catch {
    // localStorage indisponível ou conteúdo corrompido — usa o padrão
  }
  const defaults = DEFAULT_SCREENSHOT_OPTIONS
  const storedFields = (stored.fields && typeof stored.fields === 'object' ? stored.fields : {}) as Record<string, unknown>
  const fields = Object.fromEntries(
    SCREENSHOT_FIELDS.map((field) => [field, pickBoolean(storedFields[field], defaults.fields[field])]),
  ) as Record<ScreenshotField, boolean>
  return {
    layout: pick(stored.layout, ['vertical', 'sideBySide'], defaults.layout),
    theme: pick(stored.theme, ['light', 'dark'], defaults.theme),
    width: pick(stored.width, ['compact', 'standard', 'wide'], defaults.width),
    lineLimit: pick(stored.lineLimit, ['30', '60', '120', 'all'], defaults.lineLimit),
    fields,
    hideSensitive: pickBoolean(stored.hideSensitive, defaults.hideSensitive),
    includeImportMetadata: pickBoolean(stored.includeImportMetadata, defaults.includeImportMetadata),
  }
}

export function persistScreenshotOptions(options: ScreenshotOptions) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(options))
  } catch {
    // localStorage indisponível — as opções só não persistem entre sessões
  }
}
