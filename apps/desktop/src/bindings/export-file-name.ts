/** Sanitize a filename for all supported operating systems. */
function sanitizeFileName(name: string): string {
  const sanitized = name.trim().replace(/[^A-Za-z0-9-_ ]/g, '-')
  return sanitized || 'collection'
}

export type ExportFileFormat = 'alcy' | 'har' | 'png' | 'html' | 'flow'

const EXTENSIONS: Record<ExportFileFormat, string> = {
  flow: 'flow.alcy.json',
  alcy: 'alcy.json',
  har: 'har',
  png: 'png',
  html: 'html',
}

/** Name suggested in the save dialog the backend opens. The backend still
 * reduces it to a bare file name, so this only shapes how it reads. */
export function exportFileName(suggestedName: string, format: ExportFileFormat = 'alcy'): string {
  return `${sanitizeFileName(suggestedName)}.${EXTENSIONS[format]}`
}
