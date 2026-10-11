import { save } from '@tauri-apps/plugin-dialog'

/** Diálogo nativo de salvar o corpo de uma resposta, sugerindo `fileName`.
 * O filtro da extensão sugerida vem primeiro; "*" permite qualquer tipo.
 * `null` se cancelado. */
export async function pickResponseFile(fileName: string, allFilesLabel: string): Promise<string | null> {
  const dot = fileName.lastIndexOf('.')
  const extension = dot > 0 ? fileName.slice(dot + 1) : ''
  const selected = await save({
    defaultPath: fileName,
    filters: [...(extension ? [{ name: extension.toUpperCase(), extensions: [extension] }] : []), { name: allFilesLabel, extensions: ['*'] }],
  })
  return typeof selected === 'string' ? selected : null
}
