import type { SnippetRequest } from './snippet-request'

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** Generate a POSIX shell command using the saved message, including for streams. */
export function generateGrpcurlSnippet(request: SnippetRequest): string {
  const grpc = request.grpc
  if (!grpc) throw new Error('A gRPC request is required for grpcurl.')
  const notes = [...request.notes]
  if (!grpc.service || !grpc.method) notes.push('Choose a gRPC service and method before running this command.')
  if (request.digest) notes.push('Digest authentication is not supported for gRPC.')
  const endpoint = request.url.replace(/\/+$/, '')
  const match = /^(grpc|grpcs|http|https):\/\/(.*)$/i.exec(endpoint)
  let address = match?.[2] ?? endpoint
  const hasPort = /:\d+$/.test(address)
  const tls = match ? /^(grpcs|https)$/i.test(match[1]) : /:443$/.test(address)
  if (!hasPort && address) address += tls ? ':443' : ':80'
  const args: string[] = tls ? [] : ['-plaintext']
  if (grpc.schemaSource.type === 'protoFiles') {
    notes.push('Run from the workspace folder, or adjust the .proto and import paths.')
    const paths = new Set(grpc.schemaSource.importPaths)
    for (const file of grpc.schemaSource.files) {
      const normalized = file.replace(/\\/g, '/')
      const separator = normalized.lastIndexOf('/')
      if (separator >= 0) {
        const directory = normalized.slice(0, separator) || '/'
        paths.add(directory.endsWith(':') ? `${directory}/` : directory)
      }
    }
    paths.add('.')
    for (const path of paths) args.push(`-import-path ${quote(path)}`)
    for (const file of grpc.schemaSource.files) args.push(`-proto ${quote(file)}`)
  }
  if (grpc.deadlineMs != null && grpc.deadlineMs > 0) args.push(`-max-time ${grpc.deadlineMs / 1000}`)
  for (const header of request.headers) args.push(`-H ${quote(`${header.name}: ${header.value}`)}`)
  args.push(`-d ${quote(request.body.type === 'text' ? request.body.text : '{}')}`)
  args.push('--', quote(address || '<host:port>'), quote(`${grpc.service || '<service>'}/${grpc.method || '<method>'}`))
  return [...notes.map((note) => `# ${note.replace(/[\r\n]+/g, ' ')}`), `grpcurl ${args.join(' \\\n  ')}`].join('\n')
}
