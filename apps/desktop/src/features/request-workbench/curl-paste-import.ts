import { importCollectionsFromText } from '../../bindings/import-collections-from-text'
import type { RequestContent } from './collection-tree'
import { firstRequest } from './image-import'
import { requestFromDto } from './use-collections-state'

/** Mesma regra do parser (`starts_with_supported_command`): a primeira linha
 * útil, sem o prompt `$ `, começa com `curl` ou `wget`. Linhas em branco e
 * comentários `#` antes do comando são ignorados. */
export function isShellCommand(text: string): boolean {
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value !== '' && !value.startsWith('#'))
  if (!line) return false
  const command = line.replace(/^\$\s+/, '')
  return /^(curl|wget)(\s|$)/.test(command)
}

export type CurlRequestResult = { ok: true; content: RequestContent } | { ok: false; message: string | null }

/** Converte o comando colado na barra de endpoint no conteúdo de uma
 * requisição. Com vários comandos, vale o primeiro. `message: null` quando o
 * texto foi lido, mas não gerou nenhuma requisição. */
export async function readCurlRequest(text: string, rootPath: string): Promise<CurlRequestResult> {
  const result = await importCollectionsFromText(text, rootPath)
  if (!result.ok) return { ok: false, message: result.error.message }
  const dto = firstRequest(result.value.collections)
  return dto ? { ok: true, content: requestFromDto(dto).content } : { ok: false, message: null }
}
