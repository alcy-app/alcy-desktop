import type { Language } from '../../shared/i18n/translations'

const MEGABYTE = 1024 * 1024

/** Tamanho em MB com uma casa decimal, no formato do idioma. */
export function formatMegabytes(bytes: number, language: Language): string {
  return new Intl.NumberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / MEGABYTE)
}

/** Data de publicação da release (`null` se ausente ou inválida). */
export function formatReleaseDate(iso: string | null, language: Language): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(language, { day: '2-digit', month: 'short', year: 'numeric' }).format(date)
}

export function formatCheckTime(timestamp: number, language: Language): string {
  return new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp))
}

/** Percentual inteiro do download, ou `null` sem tamanho total conhecido. */
export function downloadPercent(downloaded: number, total: number | null): number | null {
  if (!total) return null
  return Math.min(100, Math.floor((downloaded / total) * 100))
}
