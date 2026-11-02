import type { SnippetRequest } from './snippet-request'

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** A POSIX shell command that connects with `websocat`, sends the composer
 * message and keeps printing what the server sends (spec 0140). */
export function generateWebsocatSnippet(request: SnippetRequest): string {
  const websocket = request.websocket
  if (!websocket) throw new Error('A WebSocket request is required for websocat.')
  const notes = [...request.notes]
  if (request.digest) notes.push('websocat does not support Digest authentication; add the Authorization header yourself.')
  const binary = websocket.messageFormat === 'binary'
  const args: string[] = []
  // Without -n, websocat closes as soon as the message is sent.
  args.push('-n')
  if (binary) args.push('--binary')
  for (const subprotocol of websocket.subprotocols) args.push(`--protocol ${quote(subprotocol)}`)
  for (const header of request.headers) args.push(`-H ${quote(`${header.name}: ${header.value}`)}`)
  args.push(quote(request.url || 'ws://<host>/<path>'))
  const command = `websocat ${args.join(' \\\n  ')}`
  const message = request.body.type === 'text' ? request.body.text : ''
  const input =
    message === ''
      ? ''
      : binary
        ? `printf '%s' ${quote(message.replace(/\s+/g, ''))} | base64 -d | `
        : `printf '%s\\n' ${quote(message.replace(/\r?\n/g, ' '))} | `
  return [...notes.map((note) => `# ${note.replace(/[\r\n]+/g, ' ')}`), input + command].join('\n')
}
