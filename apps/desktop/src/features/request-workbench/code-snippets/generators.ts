import { fileNameOf } from '../body-state'
import type { SnippetField, SnippetRequest } from './snippet-request'

/** Linguagem de destaque de sintaxe usada no preview (ver `snippet-highlight.ts`). */
export type SnippetHighlight =
  | 'shell'
  | 'javascript'
  | 'python'
  | 'go'
  | 'java'
  | 'csharp'
  | 'php'
  | 'ruby'
  | 'powershell'
  | 'kotlin'
  | 'swift'
  | 'rust'

export type SnippetLanguageId =
  | 'curl'
  | 'wget'
  | 'httpie'
  | 'javascript-fetch'
  | 'javascript-axios'
  | 'python-requests'
  | 'go'
  | 'java'
  | 'csharp'
  | 'php'
  | 'ruby'
  | 'powershell'
  | 'kotlin'
  | 'swift'
  | 'rust'

export interface SnippetLanguage {
  id: SnippetLanguageId
  label: string
  highlight: SnippetHighlight
}

type Generator = (request: SnippetRequest) => string

// ---------------------------------------------------------------------------
// Literais de string por linguagem
// ---------------------------------------------------------------------------

const hex4 = (code: number) => `\\u${code.toString(16).padStart(4, '0')}`
const braced = (code: number) => `\\u{${code.toString(16)}}`

/** Conteúdo de um literal entre aspas duplas no estilo C: escapa aspas,
 * barra invertida e caracteres de controle. `extra` cobre o que só é
 * especial numa linguagem (ex.: `$` em Kotlin, `#` em Ruby). */
function escapeInner(value: string, unicode: (code: number) => string, extra: Record<string, string> = {}): string {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (char in extra) out += extra[char]
    else if (char === '"') out += '\\"'
    else if (char === '\\') out += '\\\\'
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (char === '\t') out += '\\t'
    else if (code < 0x20 || code === 0x7f) out += unicode(code)
    else out += char
  }
  return out
}

/** Aspas duplas válidas em JavaScript, Python, Go, Java e C#. */
const dq = (value: string) => `"${escapeInner(value, hex4)}"`
const kotlinString = (value: string) => `"${escapeInner(value, hex4, { $: '\\$' })}"`
const rubyString = (value: string) => `"${escapeInner(value, hex4, { '#': '\\#' })}"`
const swiftInner = (value: string) => escapeInner(value, braced)
const swiftString = (value: string) => `"${swiftInner(value)}"`
const rustString = (value: string) => `"${escapeInner(value, braced)}"`
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
const phpString = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const powershellString = (value: string) => `'${value.replace(/'/g, "''")}'`

/** Texto multilinha fica legível como raw string do Go quando não tem crase nem `\r`. */
function goText(value: string): string {
  return value.includes('\n') && !value.includes('`') && !value.includes('\r') ? `\`${value}\`` : dq(value)
}

function csharpText(value: string): string {
  return value.includes('\n') ? `@"${value.replace(/"/g, '""')}"` : dq(value)
}

function rustText(value: string): string {
  if (!value.includes('\n') && !value.includes('"') && !value.includes('\\')) return rustString(value)
  let hashes = '#'
  while (value.includes(`"${hashes}`)) hashes += '#'
  return `r${hashes}"${value}"${hashes}`
}

// ---------------------------------------------------------------------------
// Utilitários comuns
// ---------------------------------------------------------------------------

/** Indenta todas as linhas depois da primeira (a primeira já está na posição do chamador). */
function indentRest(text: string, pad: string): string {
  return text.split('\n').join(`\n${pad}`)
}

/** Objeto/array JSON do corpo, para gerar um literal nativo; `undefined` se
 * não for JSON ou se reescrevê-lo pudesse alterar o valor (inteiros além da
 * precisão de `number`, chave `__proto__`). */
function jsonDocument(text: string): object | undefined {
  if (/\d{16,}/.test(text) || text.includes('"__proto__"')) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

function pythonLiteral(value: unknown, depth = 0): string {
  const pad = '    '.repeat(depth + 1)
  const close = '    '.repeat(depth)
  if (value === null) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'number') return JSON.stringify(value)
  if (typeof value === 'string') return dq(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[\n${value.map((item) => `${pad}${pythonLiteral(item, depth + 1)}`).join(',\n')},\n${close}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return '{}'
  return `{\n${entries.map(([key, item]) => `${pad}${dq(key)}: ${pythonLiteral(item, depth + 1)}`).join(',\n')},\n${close}}`
}

function urlEncoded(fields: SnippetField[]): string {
  return new URLSearchParams(fields.map((field) => [field.name, field.value])).toString()
}

function isContentType(header: SnippetField): boolean {
  return header.name.toLowerCase() === 'content-type'
}

function contentTypeOf(request: SnippetRequest): string | null {
  return request.headers.find(isContentType)?.value ?? null
}

function digestNote(request: SnippetRequest): string[] {
  return request.digest
    ? [`Digest authentication (user "${request.digest.username}") is not generated for this language; configure it in your HTTP client.`]
    : []
}

function comments(notes: string[], prefix: string): string[] {
  return notes.map((note) => `${prefix} ${note}`)
}

function hasFiles(request: SnippetRequest): boolean {
  return request.body.type === 'file' || (request.body.type === 'formData' && request.body.fields.some((field) => field.kind === 'file'))
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const curl: Generator = (request) => {
  const args = [request.method === 'HEAD' ? '--head' : `--request ${request.method}`, `--url ${shellQuote(request.url)}`]
  for (const header of request.headers) {
    // `Nome;` envia o header vazio; `Nome:` faria o curl removê-lo.
    args.push(`--header ${shellQuote(header.value ? `${header.name}: ${header.value}` : `${header.name};`)}`)
  }
  if (request.digest) {
    args.push('--digest', `--user ${shellQuote(`${request.digest.username}:${request.digest.password}`)}`)
  }
  const body = request.body
  switch (body.type) {
    case 'text':
      args.push(`--data-raw ${shellQuote(body.text)}`)
      break
    case 'urlencoded':
      for (const field of body.fields) {
        args.push(`--data-urlencode ${shellQuote(`${encodeURIComponent(field.name)}=${field.value}`)}`)
      }
      break
    case 'formData':
      for (const field of body.fields) {
        args.push(
          field.kind === 'file'
            ? `--form ${shellQuote(`${field.name}=@${field.path}`)}`
            : `--form-string ${shellQuote(`${field.name}=${field.value}`)}`,
        )
      }
      break
    case 'file':
      args.push(`--data-binary ${shellQuote(`@${body.path}`)}`)
      break
    case 'none':
      break
  }
  return [...comments(request.notes, '#'), `curl ${args.join(' \\\n  ')}`].join('\n')
}

const wget: Generator = (request) => {
  const notes = [...request.notes]
  const args = ['--quiet', `--method=${request.method}`]
  for (const header of request.headers) args.push(`--header=${shellQuote(`${header.name}: ${header.value}`)}`)
  if (request.digest) {
    args.push(`--user=${shellQuote(request.digest.username)}`, `--password=${shellQuote(request.digest.password)}`)
  }
  const body = request.body
  switch (body.type) {
    case 'text':
      args.push(`--body-data=${shellQuote(body.text)}`)
      break
    case 'urlencoded':
      args.push(`--body-data=${shellQuote(urlEncoded(body.fields))}`)
      break
    case 'formData':
      notes.push('wget does not support multipart/form-data bodies; use cURL or HTTPie for this request.')
      break
    case 'file':
      args.push(`--body-file=${shellQuote(body.path)}`)
      break
    case 'none':
      break
  }
  args.push('--output-document=-', shellQuote(request.url))
  return [...comments(notes, '#'), `wget ${args.join(' \\\n  ')}`].join('\n')
}

const httpie: Generator = (request) => {
  const options: string[] = []
  const items = request.headers.map((header) =>
    // `Nome;` envia o header vazio; `Nome:` faria o HTTPie removê-lo.
    shellQuote(header.value ? `${header.name}:${header.value}` : `${header.name};`),
  )
  const escapeKey = (name: string) => name.replace(/([=:@\\])/g, '\\$1')
  let stdin = ''
  if (request.digest) {
    options.push('--auth-type=digest', `--auth=${shellQuote(`${request.digest.username}:${request.digest.password}`)}`)
  }
  const body = request.body
  switch (body.type) {
    case 'text':
      options.push(`--raw=${shellQuote(body.text)}`)
      break
    case 'urlencoded':
      options.push('--form')
      for (const field of body.fields) items.push(shellQuote(`${escapeKey(field.name)}=${field.value}`))
      break
    case 'formData':
      options.push('--multipart')
      for (const field of body.fields) {
        items.push(
          shellQuote(field.kind === 'file' ? `${escapeKey(field.name)}@${field.path}` : `${escapeKey(field.name)}=${field.value}`),
        )
      }
      break
    case 'file':
      stdin = ` < ${shellQuote(body.path)}`
      break
    case 'none':
      break
  }
  const command = ['http', ...options, request.method, shellQuote(request.url), ...items].join(' \\\n  ')
  return [...comments(request.notes, '#'), `${command}${stdin}`].join('\n')
}

// ---------------------------------------------------------------------------
// JavaScript
// ---------------------------------------------------------------------------

/** `[["nome", "valor"], …]` — preserva nomes repetidos, ao contrário de um objeto. */
function jsPairs(fields: SnippetField[], pad: string): string {
  if (fields.length === 0) return '[]'
  return `[${fields.map((field) => `\n${pad}  [${dq(field.name)}, ${dq(field.value)}],`).join('')}\n${pad}]`
}

/** Linhas que montam `form` (FormData) e o import de leitura de arquivo, quando necessário. */
function jsPreamble(request: SnippetRequest): { imports: string[]; setup: string[] } {
  const imports = hasFiles(request) ? ['import { readFile } from "node:fs/promises"'] : []
  const setup: string[] = []
  if (request.body.type === 'formData') {
    setup.push('const form = new FormData()')
    for (const field of request.body.fields) {
      setup.push(
        field.kind === 'file'
          ? `form.append(${dq(field.name)}, new Blob([await readFile(${dq(field.path)})]), ${dq(fileNameOf(field.path))})`
          : `form.append(${dq(field.name)}, ${dq(field.value)})`,
      )
    }
    setup.push('')
  }
  return { imports, setup }
}

function jsHeaders(request: SnippetRequest): string[] {
  if (request.headers.length === 0) return []
  return ['  headers: {', ...request.headers.map((header) => `    ${dq(header.name)}: ${dq(header.value)},`), '  },']
}

const javascriptFetch: Generator = (request) => {
  const { imports, setup } = jsPreamble(request)
  const body = request.body
  let bodyExpression: string | null = null
  switch (body.type) {
    case 'text': {
      const json = jsonDocument(body.text)
      bodyExpression = json ? `JSON.stringify(${indentRest(JSON.stringify(json, null, 2), '  ')})` : dq(body.text)
      break
    }
    case 'urlencoded':
      bodyExpression = `new URLSearchParams(${jsPairs(body.fields, '  ')})`
      break
    case 'formData':
      bodyExpression = 'form'
      break
    case 'file':
      bodyExpression = `await readFile(${dq(body.path)})`
      break
    case 'none':
      break
  }
  return [
    ...comments([...request.notes, ...digestNote(request)], '//'),
    ...(imports.length > 0 ? [...imports, ''] : []),
    ...setup,
    'const options = {',
    `  method: ${dq(request.method)},`,
    ...jsHeaders(request),
    ...(bodyExpression ? [`  body: ${bodyExpression},`] : []),
    '}',
    '',
    `const response = await fetch(${dq(request.url)}, options)`,
    'console.log(await response.text())',
  ].join('\n')
}

const javascriptAxios: Generator = (request) => {
  const { imports, setup } = jsPreamble(request)
  const body = request.body
  let dataExpression: string | null = null
  switch (body.type) {
    case 'text': {
      const json = jsonDocument(body.text)
      dataExpression = json ? indentRest(JSON.stringify(json, null, 2), '  ') : dq(body.text)
      break
    }
    case 'urlencoded':
      dataExpression = `new URLSearchParams(${jsPairs(body.fields, '  ')})`
      break
    case 'formData':
      dataExpression = 'form'
      break
    case 'file':
      dataExpression = `await readFile(${dq(body.path)})`
      break
    case 'none':
      break
  }
  return [
    ...comments([...request.notes, ...digestNote(request)], '//'),
    'import axios from "axios"',
    ...imports,
    '',
    ...setup,
    'const response = await axios.request({',
    `  method: ${dq(request.method.toLowerCase())},`,
    `  url: ${dq(request.url)},`,
    ...jsHeaders(request),
    ...(dataExpression ? [`  data: ${dataExpression},`] : []),
    '})',
    'console.log(response.data)',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const pythonRequests: Generator = (request) => {
  const lines = [...comments(request.notes, '#'), 'import requests']
  if (request.digest) lines.push('from requests.auth import HTTPDigestAuth')
  lines.push('', `url = ${dq(request.url)}`)
  const args = [dq(request.method), 'url']

  if (request.headers.length > 0) {
    lines.push('headers = {', ...request.headers.map((header) => `    ${dq(header.name)}: ${dq(header.value)},`), '}')
    args.push('headers=headers')
  }

  const tuples = (entries: [string, string][]) =>
    `[\n${entries.map(([name, value]) => `    (${dq(name)}, ${value}),`).join('\n')}\n]`
  const body = request.body
  switch (body.type) {
    case 'text': {
      const json = jsonDocument(body.text)
      lines.push(`payload = ${json ? pythonLiteral(json) : dq(body.text)}`)
      args.push(json ? 'json=payload' : 'data=payload')
      break
    }
    case 'urlencoded':
      lines.push(`payload = ${tuples(body.fields.map((field) => [field.name, dq(field.value)]))}`)
      args.push('data=payload')
      break
    case 'formData': {
      const texts = body.fields.flatMap((field) => (field.kind === 'text' ? [[field.name, dq(field.value)] as [string, string]] : []))
      const files = body.fields.flatMap((field) =>
        field.kind === 'file' ? [[field.name, `open(${dq(field.path)}, "rb")`] as [string, string]] : [],
      )
      if (texts.length > 0) {
        lines.push(`payload = ${tuples(texts)}`)
        args.push('data=payload')
      }
      if (files.length > 0) {
        lines.push(`files = ${tuples(files)}`)
        args.push('files=files')
      }
      break
    }
    case 'file':
      lines.push(`payload = open(${dq(body.path)}, "rb")`)
      args.push('data=payload')
      break
    case 'none':
      break
  }
  if (request.digest) args.push(`auth=HTTPDigestAuth(${dq(request.digest.username)}, ${dq(request.digest.password)})`)

  lines.push('', `response = requests.request(${args.join(', ')})`, 'print(response.text)')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const go: Generator = (request) => {
  const imports = new Set(['fmt', 'io', 'net/http'])
  const setup: string[] = []
  const panicOnError = ['\tif err != nil {', '\t\tpanic(err)', '\t}']
  let payload = 'nil'
  let multipart = false
  const body = request.body
  switch (body.type) {
    case 'text':
      imports.add('strings')
      setup.push(`\tpayload := strings.NewReader(${goText(body.text)})`)
      payload = 'payload'
      break
    case 'urlencoded':
      imports.add('strings')
      setup.push(`\tpayload := strings.NewReader(${dq(urlEncoded(body.fields))})`)
      payload = 'payload'
      break
    case 'formData':
      multipart = true
      imports.add('bytes').add('mime/multipart')
      setup.push('\tpayload := &bytes.Buffer{}', '\twriter := multipart.NewWriter(payload)')
      body.fields.forEach((field, index) => {
        if (field.kind === 'text') {
          setup.push(`\t_ = writer.WriteField(${dq(field.name)}, ${dq(field.value)})`)
          return
        }
        imports.add('os').add('path/filepath')
        setup.push(
          `\tfile${index}, err := os.Open(${dq(field.path)})`,
          ...panicOnError,
          `\tdefer file${index}.Close()`,
          `\tpart${index}, err := writer.CreateFormFile(${dq(field.name)}, filepath.Base(${dq(field.path)}))`,
          ...panicOnError,
          `\tif _, err := io.Copy(part${index}, file${index}); err != nil {`,
          '\t\tpanic(err)',
          '\t}',
        )
      })
      setup.push('\tif err := writer.Close(); err != nil {', '\t\tpanic(err)', '\t}')
      payload = 'payload'
      break
    case 'file':
      imports.add('os')
      setup.push(`\tpayload, err := os.Open(${dq(body.path)})`, ...panicOnError, '\tdefer payload.Close()')
      payload = 'payload'
      break
    case 'none':
      break
  }

  return [
    ...comments([...request.notes, ...digestNote(request)], '//'),
    'package main',
    '',
    'import (',
    ...[...imports].sort().map((name) => `\t"${name}"`),
    ')',
    '',
    'func main() {',
    `\turl := ${dq(request.url)}`,
    ...setup,
    '',
    `\treq, err := http.NewRequest(${dq(request.method)}, url, ${payload})`,
    ...panicOnError,
    ...request.headers.map((header) => `\treq.Header.Add(${dq(header.name)}, ${dq(header.value)})`),
    ...(multipart ? ['\treq.Header.Set("Content-Type", writer.FormDataContentType())'] : []),
    '',
    '\tres, err := http.DefaultClient.Do(req)',
    ...panicOnError,
    '\tdefer res.Body.Close()',
    '',
    '\tbody, err := io.ReadAll(res.Body)',
    ...panicOnError,
    '\tfmt.Println(string(body))',
    '}',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Java / C#
// ---------------------------------------------------------------------------

const java: Generator = (request) => {
  const notes = [...request.notes, ...digestNote(request)]
  const imports = ['java.net.URI', 'java.net.http.HttpClient', 'java.net.http.HttpRequest', 'java.net.http.HttpResponse']
  let publisher = 'HttpRequest.BodyPublishers.noBody()'
  const body = request.body
  switch (body.type) {
    case 'text':
      publisher = `HttpRequest.BodyPublishers.ofString(${dq(body.text)})`
      break
    case 'urlencoded':
      publisher = `HttpRequest.BodyPublishers.ofString(${dq(urlEncoded(body.fields))})`
      break
    case 'formData':
      notes.push(
        `java.net.http has no multipart/form-data encoder; send the fields ${body.fields.map((field) => `"${field.name}"`).join(', ')} with a multipart library.`,
      )
      break
    case 'file':
      imports.push('java.nio.file.Path')
      publisher = `HttpRequest.BodyPublishers.ofFile(Path.of(${dq(body.path)}))`
      break
    case 'none':
      break
  }
  return [
    ...comments(notes, '//'),
    ...imports.map((name) => `import ${name};`),
    '',
    'public class Main {',
    '    public static void main(String[] args) throws Exception {',
    '        HttpRequest request = HttpRequest.newBuilder()',
    `            .uri(URI.create(${dq(request.url)}))`,
    ...request.headers.map((header) => `            .header(${dq(header.name)}, ${dq(header.value)})`),
    `            .method(${dq(request.method)}, ${publisher})`,
    '            .build();',
    '',
    '        HttpResponse<String> response = HttpClient.newHttpClient()',
    '            .send(request, HttpResponse.BodyHandlers.ofString());',
    '        System.out.println(response.body());',
    '    }',
    '}',
  ].join('\n')
}

const csharp: Generator = (request) => {
  const body = request.body
  const contentType = contentTypeOf(request)
  // Content-Type pertence ao conteúdo em HttpClient; urlencoded/multipart geram o próprio.
  const contentTypeOnContent = contentType !== null && (body.type === 'text' || body.type === 'file')
  const requestHeaders = request.headers.filter((header) => !isContentType(header) || body.type === 'none')
  const lines = [...comments([...request.notes, ...digestNote(request)], '//')]
  if (contentTypeOnContent) lines.push('using System.Net.Http.Headers;', '')
  lines.push(
    'using var client = new HttpClient();',
    `using var request = new HttpRequestMessage(new HttpMethod(${dq(request.method)}), ${dq(request.url)});`,
    ...requestHeaders.map((header) => `request.Headers.TryAddWithoutValidation(${dq(header.name)}, ${dq(header.value)});`),
  )
  switch (body.type) {
    case 'text':
      lines.push(`request.Content = new StringContent(${csharpText(body.text)});`)
      break
    case 'urlencoded':
      lines.push(
        'request.Content = new FormUrlEncodedContent(new[]',
        '{',
        ...body.fields.map((field) => `    new KeyValuePair<string, string>(${dq(field.name)}, ${dq(field.value)}),`),
        '});',
      )
      break
    case 'formData':
      lines.push('var form = new MultipartFormDataContent();')
      for (const field of body.fields) {
        lines.push(
          field.kind === 'file'
            ? `form.Add(new StreamContent(File.OpenRead(${dq(field.path)})), ${dq(field.name)}, Path.GetFileName(${dq(field.path)}));`
            : `form.Add(new StringContent(${csharpText(field.value)}), ${dq(field.name)});`,
        )
      }
      lines.push('request.Content = form;')
      break
    case 'file':
      lines.push(`request.Content = new StreamContent(File.OpenRead(${dq(body.path)}));`)
      break
    case 'none':
      break
  }
  if (contentTypeOnContent && contentType !== null) {
    lines.push(`request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(${dq(contentType)});`)
  }
  lines.push(
    '',
    'using var response = await client.SendAsync(request);',
    'Console.WriteLine(await response.Content.ReadAsStringAsync());',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// PHP / Ruby / PowerShell
// ---------------------------------------------------------------------------

const php: Generator = (request) => {
  const options = [
    `    CURLOPT_URL => ${phpString(request.url)},`,
    '    CURLOPT_RETURNTRANSFER => true,',
    `    CURLOPT_CUSTOMREQUEST => ${phpString(request.method)},`,
  ]
  if (request.method === 'HEAD') options.push('    CURLOPT_NOBODY => true,')
  if (request.headers.length > 0) {
    options.push(
      '    CURLOPT_HTTPHEADER => [',
      ...request.headers.map((header) => `        ${phpString(`${header.name}: ${header.value}`)},`),
      '    ],',
    )
  }
  if (request.digest) {
    options.push(
      '    CURLOPT_HTTPAUTH => CURLAUTH_DIGEST,',
      `    CURLOPT_USERPWD => ${phpString(`${request.digest.username}:${request.digest.password}`)},`,
    )
  }
  const body = request.body
  switch (body.type) {
    case 'text':
      options.push(`    CURLOPT_POSTFIELDS => ${phpString(body.text)},`)
      break
    case 'urlencoded':
      options.push(`    CURLOPT_POSTFIELDS => ${phpString(urlEncoded(body.fields))},`)
      break
    case 'formData':
      options.push(
        '    CURLOPT_POSTFIELDS => [',
        ...body.fields.map(
          (field) =>
            `        ${phpString(field.name)} => ${field.kind === 'file' ? `new CURLFile(${phpString(field.path)})` : phpString(field.value)},`,
        ),
        '    ],',
      )
      break
    case 'file':
      options.push(`    CURLOPT_POSTFIELDS => file_get_contents(${phpString(body.path)}),`)
      break
    case 'none':
      break
  }
  return [
    '<?php',
    '',
    ...comments(request.notes, '//'),
    '$curl = curl_init();',
    '',
    'curl_setopt_array($curl, [',
    ...options,
    ']);',
    '',
    '$response = curl_exec($curl);',
    'if ($response === false) {',
    "    echo 'Error: ' . curl_error($curl);",
    '} else {',
    '    echo $response;',
    '}',
    'curl_close($curl);',
  ].join('\n')
}

const ruby: Generator = (request) => {
  const body = request.body
  const lines = [
    ...comments([...request.notes, ...digestNote(request)], '#'),
    'require "net/http"',
    'require "uri"',
    '',
    `uri = URI(${rubyString(request.url)})`,
    'http = Net::HTTP.new(uri.host, uri.port)',
    'http.use_ssl = uri.scheme == "https"',
    '',
    `request = Net::HTTPGenericRequest.new(${rubyString(request.method)}, ${body.type !== 'none'}, ${request.method !== 'HEAD'}, uri.request_uri)`,
    ...request.headers.map((header) => `request.add_field(${rubyString(header.name)}, ${rubyString(header.value)})`),
  ]
  switch (body.type) {
    case 'text':
      lines.push(`request.body = ${rubyString(body.text)}`)
      break
    case 'urlencoded':
      lines.push(
        'request.body = URI.encode_www_form([',
        ...body.fields.map((field) => `  [${rubyString(field.name)}, ${rubyString(field.value)}],`),
        '])',
      )
      break
    case 'formData':
      lines.push(
        'request.set_form([',
        ...body.fields.map(
          (field) =>
            `  [${rubyString(field.name)}, ${field.kind === 'file' ? `File.open(${rubyString(field.path)})` : rubyString(field.value)}],`,
        ),
        '], "multipart/form-data")',
      )
      break
    case 'file':
      lines.push(`request.body = File.binread(${rubyString(body.path)})`)
      break
    case 'none':
      break
  }
  lines.push('', 'response = http.request(request)', 'puts response.body')
  return lines.join('\n')
}

const powershell: Generator = (request) => {
  const notes = [...request.notes, ...digestNote(request)]
  const headers = request.headers.filter((header) => !isContentType(header))
  const contentType = contentTypeOf(request)
  const lines: string[] = []
  const args = [`-Uri ${powershellString(request.url)}`, `-Method ${request.method}`]
  if (headers.length > 0) {
    lines.push(
      '$headers = @{',
      ...headers.map((header) => `    ${powershellString(header.name)} = ${powershellString(header.value)}`),
      '}',
    )
    args.push('-Headers $headers')
  }
  const body = request.body
  switch (body.type) {
    case 'text':
      lines.push(`$body = ${powershellString(body.text)}`)
      args.push('-Body $body')
      break
    case 'urlencoded':
      lines.push(`$body = ${powershellString(urlEncoded(body.fields))}`)
      args.push('-Body $body')
      break
    case 'formData':
      notes.push('-Form requires PowerShell 7 or later.')
      lines.push(
        '$form = @{',
        ...body.fields.map(
          (field) =>
            `    ${powershellString(field.name)} = ${field.kind === 'file' ? `(Get-Item -LiteralPath ${powershellString(field.path)})` : powershellString(field.value)}`,
        ),
        '}',
      )
      args.push('-Form $form')
      break
    case 'file':
      args.push(`-InFile ${powershellString(body.path)}`)
      break
    case 'none':
      break
  }
  if (contentType !== null && body.type !== 'formData') args.push(`-ContentType ${powershellString(contentType)}`)
  return [
    ...comments(notes, '#'),
    ...lines,
    ...(lines.length > 0 ? [''] : []),
    `$response = Invoke-RestMethod ${args.join(' `\n    ')}`,
    '$response',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Kotlin / Swift / Rust
// ---------------------------------------------------------------------------

const kotlin: Generator = (request) => {
  const notes = [...request.notes, ...digestNote(request)]
  const imports = new Set(['okhttp3.OkHttpClient', 'okhttp3.Request'])
  const contentType = contentTypeOf(request)
  const mediaType = contentType === null ? '' : `${kotlinString(contentType)}.toMediaType()`
  if (contentType !== null) imports.add('okhttp3.MediaType.Companion.toMediaType')
  const setup: string[] = []
  const permitsBody = request.method !== 'GET' && request.method !== 'HEAD'
  let body = request.body
  if (!permitsBody && body.type !== 'none') {
    notes.push(`OkHttp does not allow a request body with ${request.method}; the body was left out.`)
    body = { type: 'none' }
  }
  switch (body.type) {
    case 'text':
      imports.add('okhttp3.RequestBody.Companion.toRequestBody')
      setup.push(`val body = ${kotlinString(body.text)}.toRequestBody(${mediaType})`)
      break
    case 'urlencoded':
      imports.add('okhttp3.FormBody')
      setup.push(
        'val body = FormBody.Builder()',
        ...body.fields.map((field) => `    .add(${kotlinString(field.name)}, ${kotlinString(field.value)})`),
        '    .build()',
      )
      break
    case 'formData':
      imports.add('okhttp3.MultipartBody')
      if (body.fields.some((field) => field.kind === 'file')) {
        imports.add('java.io.File').add('okhttp3.RequestBody.Companion.asRequestBody')
      }
      setup.push(
        'val body = MultipartBody.Builder()',
        '    .setType(MultipartBody.FORM)',
        ...body.fields.map((field) =>
          field.kind === 'file'
            ? `    .addFormDataPart(${kotlinString(field.name)}, File(${kotlinString(field.path)}).name, File(${kotlinString(field.path)}).asRequestBody())`
            : `    .addFormDataPart(${kotlinString(field.name)}, ${kotlinString(field.value)})`,
        ),
        '    .build()',
      )
      break
    case 'file':
      imports.add('java.io.File').add('okhttp3.RequestBody.Companion.asRequestBody')
      setup.push(`val body = File(${kotlinString(body.path)}).asRequestBody(${mediaType})`)
      break
    case 'none':
      if (permitsBody && request.method !== 'DELETE' && request.method !== 'OPTIONS') {
        // POST/PUT/PATCH exigem corpo no OkHttp, mesmo vazio.
        imports.add('okhttp3.RequestBody.Companion.toRequestBody')
        setup.push(`val body = "".toRequestBody(${mediaType})`)
      }
      break
  }
  const bodyArgument = setup.length > 0 ? 'body' : 'null'
  // Com corpo, o Content-Type sai do media type; repeti-lo como header seria redundante.
  const headers = request.headers.filter((header) => bodyArgument === 'null' || !isContentType(header))
  return [
    ...comments(notes, '//'),
    ...[...imports].sort().map((name) => `import ${name}`),
    '',
    'val client = OkHttpClient()',
    '',
    ...setup,
    ...(setup.length > 0 ? [''] : []),
    'val request = Request.Builder()',
    `    .url(${kotlinString(request.url)})`,
    `    .method(${kotlinString(request.method)}, ${bodyArgument})`,
    ...headers.map((header) => `    .addHeader(${kotlinString(header.name)}, ${kotlinString(header.value)})`),
    '    .build()',
    '',
    'client.newCall(request).execute().use { response ->',
    '    println(response.body?.string())',
    '}',
  ].join('\n')
}

const swift: Generator = (request) => {
  const lines = [
    ...comments([...request.notes, ...digestNote(request)], '//'),
    'import Foundation',
    '',
    `var request = URLRequest(url: URL(string: ${swiftString(request.url)})!)`,
    `request.httpMethod = ${swiftString(request.method)}`,
    ...request.headers.map((header) => `request.addValue(${swiftString(header.value)}, forHTTPHeaderField: ${swiftString(header.name)})`),
  ]
  const body = request.body
  switch (body.type) {
    case 'text':
      lines.push(`request.httpBody = Data(${swiftString(body.text)}.utf8)`)
      break
    case 'urlencoded':
      lines.push(`request.httpBody = Data(${swiftString(urlEncoded(body.fields))}.utf8)`)
      break
    case 'formData':
      lines.push(
        '',
        'let boundary = "Boundary-\\(UUID().uuidString)"',
        'request.setValue("multipart/form-data; boundary=\\(boundary)", forHTTPHeaderField: "Content-Type")',
        'var body = Data()',
      )
      body.fields.forEach((field, index) => {
        if (field.kind === 'text') {
          const part = swiftInner(`Content-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`)
          lines.push(`body.append(Data("--\\(boundary)\\r\\n${part}".utf8))`)
          return
        }
        const disposition = swiftInner(`Content-Disposition: form-data; name="${field.name}"; filename="`)
        lines.push(
          `let file${index} = URL(fileURLWithPath: ${swiftString(field.path)})`,
          `body.append(Data("--\\(boundary)\\r\\n${disposition}\\(file${index}.lastPathComponent)\\"\\r\\n\\r\\n".utf8))`,
          `body.append(try Data(contentsOf: file${index}))`,
          'body.append(Data("\\r\\n".utf8))',
        )
      })
      lines.push('body.append(Data("--\\(boundary)--\\r\\n".utf8))', 'request.httpBody = body')
      break
    case 'file':
      lines.push(`request.httpBody = try Data(contentsOf: URL(fileURLWithPath: ${swiftString(body.path)}))`)
      break
    case 'none':
      break
  }
  lines.push(
    '',
    'let (data, _) = try await URLSession.shared.data(for: request)',
    'print(String(decoding: data, as: UTF8.self))',
  )
  return lines.join('\n')
}

const rust: Generator = (request) => {
  const body = request.body
  const multipart = body.type === 'formData'
  const features = multipart ? '"blocking", "multipart"' : '"blocking"'
  const setup: string[] = []
  const builder = [
    '    let response = Client::new()',
    `        .request(reqwest::Method::${request.method}, ${rustString(request.url)})`,
    ...request.headers.map((header) => `        .header(${rustString(header.name)}, ${rustString(header.value)})`),
  ]
  switch (body.type) {
    case 'text':
      builder.push(`        .body(${rustText(body.text)})`)
      break
    case 'urlencoded':
      builder.push(
        '        .form(&[',
        ...body.fields.map((field) => `            (${rustString(field.name)}, ${rustString(field.value)}),`),
        '        ])',
      )
      break
    case 'formData':
      setup.push(
        '    let form = Form::new()',
        ...body.fields.map((field) =>
          field.kind === 'file'
            ? `        .file(${rustString(field.name)}, ${rustString(field.path)})?`
            : `        .text(${rustString(field.name)}, ${rustString(field.value)})`,
        ),
      )
      setup[setup.length - 1] += ';'
      setup.push('')
      builder.push('        .multipart(form)')
      break
    case 'file':
      builder.push(`        .body(std::fs::read(${rustString(body.path)})?)`)
      break
    case 'none':
      break
  }
  builder.push('        .send()?;')
  return [
    ...comments([...request.notes, ...digestNote(request)], '//'),
    `// Cargo.toml: reqwest = { version = "0.12", features = [${features}] }`,
    'use reqwest::blocking::Client;',
    ...(multipart ? ['use reqwest::blocking::multipart::Form;'] : []),
    '',
    'fn main() -> Result<(), Box<dyn std::error::Error>> {',
    ...setup,
    ...builder,
    '',
    '    println!("{}", response.text()?);',
    '    Ok(())',
    '}',
  ].join('\n')
}

// ---------------------------------------------------------------------------

/** Ordem de exibição no seletor: cURL e wget primeiro, depois as mais populares. */
export const SNIPPET_LANGUAGES: SnippetLanguage[] = [
  { id: 'curl', label: 'cURL', highlight: 'shell' },
  { id: 'wget', label: 'wget', highlight: 'shell' },
  { id: 'httpie', label: 'HTTPie', highlight: 'shell' },
  { id: 'javascript-fetch', label: 'JavaScript (fetch)', highlight: 'javascript' },
  { id: 'javascript-axios', label: 'JavaScript (axios)', highlight: 'javascript' },
  { id: 'python-requests', label: 'Python (requests)', highlight: 'python' },
  { id: 'go', label: 'Go (net/http)', highlight: 'go' },
  { id: 'java', label: 'Java (HttpClient)', highlight: 'java' },
  { id: 'csharp', label: 'C# (HttpClient)', highlight: 'csharp' },
  { id: 'php', label: 'PHP (cURL)', highlight: 'php' },
  { id: 'ruby', label: 'Ruby (Net::HTTP)', highlight: 'ruby' },
  { id: 'powershell', label: 'PowerShell (Invoke-RestMethod)', highlight: 'powershell' },
  { id: 'kotlin', label: 'Kotlin (OkHttp)', highlight: 'kotlin' },
  { id: 'swift', label: 'Swift (URLSession)', highlight: 'swift' },
  { id: 'rust', label: 'Rust (reqwest)', highlight: 'rust' },
]

const GENERATORS: Record<SnippetLanguageId, Generator> = {
  curl,
  wget,
  httpie,
  'javascript-fetch': javascriptFetch,
  'javascript-axios': javascriptAxios,
  'python-requests': pythonRequests,
  go,
  java,
  csharp,
  php,
  ruby,
  powershell,
  kotlin,
  swift,
  rust,
}

export function isSnippetLanguageId(value: string): value is SnippetLanguageId {
  return Object.hasOwn(GENERATORS, value)
}

export function generateSnippet(language: SnippetLanguageId, request: SnippetRequest): string {
  return GENERATORS[language](request)
}
