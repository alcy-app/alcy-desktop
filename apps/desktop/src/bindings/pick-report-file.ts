import { save } from '@tauri-apps/plugin-dialog'
import type { RunReportFormat } from './export-collection-run-report'

const FILTERS: Record<RunReportFormat, { name: string; extension: string }> = {
  html: { name: 'HTML', extension: 'html' },
  json: { name: 'JSON', extension: 'json' },
  junit: { name: 'JUnit XML', extension: 'xml' },
}

/** Diálogo nativo de salvar o relatório do runner. `null` se cancelado. */
export async function pickReportFile(baseName: string, format: RunReportFormat): Promise<string | null> {
  const { name, extension } = FILTERS[format]
  const safeName = baseName.trim().replace(/[^A-Za-z0-9-_ ]/g, '-') || 'run'
  const selected = await save({
    defaultPath: `${safeName}.${extension}`,
    filters: [{ name, extensions: [extension] }],
  })
  return typeof selected === 'string' ? selected : null
}
