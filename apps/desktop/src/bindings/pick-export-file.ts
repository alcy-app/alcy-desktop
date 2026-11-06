import { save } from '@tauri-apps/plugin-dialog'

/** Sanitize a filename for all supported operating systems. */
function sanitizeFileName(name: string): string {
  const sanitized = name.trim().replace(/[^A-Za-z0-9-_ ]/g, '-')
  return sanitized || 'collection'
}

type ExportFileFormat = 'alcy' | 'har' | 'png' | 'html' | 'flow'

const EXPORT_FORMATS: Record<ExportFileFormat, { extension: string; filter: { name: string; extensions: string[] } }> = {
  flow: { extension: 'flow.alcy.json', filter: { name: 'Alcy Flow', extensions: ['json'] } },
  alcy: { extension: 'alcy.json', filter: { name: 'Alcy', extensions: ['json'] } },
  har: { extension: 'har', filter: { name: 'HAR', extensions: ['har'] } },
  png: { extension: 'png', filter: { name: 'PNG', extensions: ['png'] } },
  html: { extension: 'html', filter: { name: 'HTML', extensions: ['html'] } },
}

/** Open the native save dialog with the selected format's extension.
 * Return the selected path, or null when cancelled. */
export async function pickExportFile(suggestedName: string, format: ExportFileFormat = 'alcy'): Promise<string | null> {
  const { extension, filter } = EXPORT_FORMATS[format]
  const selected = await save({
    defaultPath: `${sanitizeFileName(suggestedName)}.${extension}`,
    filters: [filter],
  })
  return typeof selected === 'string' ? selected : null
}
