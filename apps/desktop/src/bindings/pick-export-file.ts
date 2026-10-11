import { save } from '@tauri-apps/plugin-dialog'

/** Sanitiza um nome para uso como nome de arquivo em qualquer sistema operacional. */
function sanitizeFileName(name: string): string {
  const sanitized = name.trim().replace(/[^A-Za-z0-9-_ ]/g, '-')
  return sanitized || 'collection'
}

type ExportFileFormat = 'alcy' | 'har' | 'png' | 'html'

const EXPORT_FORMATS: Record<ExportFileFormat, { extension: string; filter: { name: string; extensions: string[] } }> = {
  alcy: { extension: 'alcy.json', filter: { name: 'Alcy', extensions: ['json'] } },
  har: { extension: 'har', filter: { name: 'HAR', extensions: ['har'] } },
  png: { extension: 'png', filter: { name: 'PNG', extensions: ['png'] } },
  html: { extension: 'html', filter: { name: 'HTML', extensions: ['html'] } },
}

/** Abre o diálogo nativo de salvar arquivo, sugerindo `<name>.alcy.json` (ou
 * `<name>.har`/`<name>.png`/`<name>.html` com o `format` correspondente). Retorna o caminho
 * escolhido, ou `null` se o usuário cancelar. */
export async function pickExportFile(suggestedName: string, format: ExportFileFormat = 'alcy'): Promise<string | null> {
  const { extension, filter } = EXPORT_FORMATS[format]
  const selected = await save({
    defaultPath: `${sanitizeFileName(suggestedName)}.${extension}`,
    filters: [filter],
  })
  return typeof selected === 'string' ? selected : null
}
