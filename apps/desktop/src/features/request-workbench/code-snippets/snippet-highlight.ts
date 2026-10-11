import { StreamLanguage, type StreamParser } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import type { Extension } from '@codemirror/state'
import type { SnippetHighlight } from './generators'

const legacy = <T>(parser: StreamParser<T>): Extension => StreamLanguage.define(parser)

/** Destaque de sintaxe do preview. Os modos de `@codemirror/legacy-modes`
 * são importados sob demanda para ficarem fora do bundle inicial. PHP não tem
 * modo próprio no pacote: o parser de JavaScript cobre bem strings, comentários
 * e `=>` do código gerado. */
export async function loadSnippetHighlight(highlight: SnippetHighlight): Promise<Extension> {
  switch (highlight) {
    case 'javascript':
    case 'php':
      return javascript()
    case 'shell':
      return legacy((await import('@codemirror/legacy-modes/mode/shell')).shell)
    case 'python':
      return legacy((await import('@codemirror/legacy-modes/mode/python')).python)
    case 'go':
      return legacy((await import('@codemirror/legacy-modes/mode/go')).go)
    case 'java':
      return legacy((await import('@codemirror/legacy-modes/mode/clike')).java)
    case 'csharp':
      return legacy((await import('@codemirror/legacy-modes/mode/clike')).csharp)
    case 'kotlin':
      return legacy((await import('@codemirror/legacy-modes/mode/clike')).kotlin)
    case 'ruby':
      return legacy((await import('@codemirror/legacy-modes/mode/ruby')).ruby)
    case 'powershell':
      return legacy((await import('@codemirror/legacy-modes/mode/powershell')).powerShell)
    case 'swift':
      return legacy((await import('@codemirror/legacy-modes/mode/swift')).swift)
    case 'rust':
      return legacy((await import('@codemirror/legacy-modes/mode/rust')).rust)
  }
}
