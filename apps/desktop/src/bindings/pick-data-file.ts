import { open } from '@tauri-apps/plugin-dialog'

/** Abre o diálogo nativo de escolher o arquivo de dados do runner (CSV ou JSON). */
export async function pickDataFile(): Promise<string | null> {
  const selected = await open({
    directory: false,
    multiple: false,
    filters: [{ name: 'CSV / JSON', extensions: ['csv', 'json'] }],
  })
  return typeof selected === 'string' ? selected : null
}
