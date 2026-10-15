import { open } from '@tauri-apps/plugin-dialog'

/** Abre o diálogo nativo para escolher um ou mais documentos importáveis. O
 * formato de cada arquivo é decidido pelo backend a partir do conteúdo, não
 * da extensão; um arquivo de coleção Bruno em árvore (`bruno.json`, `.bru`)
 * importa a coleção inteira. */
export async function pickImportFiles(): Promise<string[]> {
  const selected = await open({
    directory: false,
    multiple: true,
    filters: [{ name: 'Alcy / OpenAPI / Postman / Bruno / Insomnia / HAR / cURL / wget', extensions: ['json', 'yaml', 'yml', 'bru', 'har', 'sh', 'txt'] }],
  })
  if (selected === null) return []
  return typeof selected === 'string' ? [selected] : selected
}

/** Abre o diálogo nativo para escolher uma pasta; o backend expande a pasta
 * nos arquivos importáveis dentro dela (`expandImportPaths`). */
export async function pickImportFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false })
  if (selected === null) return null
  return typeof selected === 'string' ? selected : (selected[0] ?? null)
}
