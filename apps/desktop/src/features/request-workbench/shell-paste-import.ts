import { importCollectionsFromText } from '../../bindings/import-collections-from-text'
import type { RequestContent } from './collection-tree'
import { firstRequest } from './image-import'
import { requestFromDto } from './use-collections-state'

/** Matches the native parser's supported executable names on the first useful
 * line, ignoring copied shell prompts, blank lines and leading comments. */
export function isShellCommand(text: string): boolean {
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value !== '' && !value.startsWith('#'))
  if (!line) return false
  const command = line.replace(/^\$\s+/, '')
  if (command.split(/\s+/, 1)[0]?.includes('://')) return false
  const executable = command.split(/\s+/, 1)[0]?.split(/[\\/]/).at(-1) ?? ''
  return /^(curl|wget|grpcurl)(\.exe)?$/i.test(executable)
}

export type ShellRequestResult = { ok: true; content: RequestContent } | { ok: false; message: string | null }

/** Converts a pasted command to the first imported request. A null error
 * message means the parser succeeded without producing a request. */
export async function readShellRequest(text: string, rootPath: string): Promise<ShellRequestResult> {
  const result = await importCollectionsFromText(text, rootPath)
  if (!result.ok) return { ok: false, message: result.error.message }
  const dto = firstRequest(result.value.collections)
  return dto ? { ok: true, content: requestFromDto(dto).content } : { ok: false, message: null }
}
