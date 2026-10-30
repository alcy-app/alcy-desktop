import { isPngPath } from './image-import'

/** Extensões que o diálogo de importar aceita (ver `pickImportFiles`). O
 * conteúdo, não a extensão, decide o formato; `sh` e `txt` entram como
 * comandos `curl`/`wget`/`grpcurl`. */
const IMPORTABLE_FILE_EXTENSIONS = new Set(['json', 'yaml', 'yml', 'bru', 'har', 'sh', 'txt'])

function fileName(path: string) {
  return path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? ''
}

/** Nome exibido nos erros de um arraste com vários arquivos. */
export function importDropPathName(path: string) {
  return fileName(path) || path
}

/** Um caminho arrastado para a janela que a importação direta sabe tratar:
 * imagem compartilhada, arquivo importável ou pasta (sem extensão). */
export function isImportDropPath(path: string): boolean {
  if (isPngPath(path)) return true
  const name = fileName(path)
  if (!name) return false
  const dot = name.lastIndexOf('.')
  // Sem extensão é tratado como pasta; o backend confirma e expande.
  if (dot <= 0) return true
  return IMPORTABLE_FILE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}
