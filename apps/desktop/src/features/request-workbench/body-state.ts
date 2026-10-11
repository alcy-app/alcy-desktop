import type { RawBodyLanguage, RestBodyInput } from '../../bindings/execute-rest-request'
import type { CodeLanguage } from './codemirror-shared'
import type { BodyState, BodyType, FormDataEntry, HeaderEntry, UrlEncodedEntry } from './request-workbench.types'

let bodyRowIdSequence = 0
export const nextBodyRowId = () => `body-row-${++bodyRowIdSequence}`

/** Corpo de uma requisição REST nova: raw JSON vazio, o mesmo comportamento
 * de antes de existir o seletor de tipo. */
export const emptyRestBody: RestBodyInput = { type: 'raw', content: '', rawLanguage: 'json' }

export const emptyBodyState: BodyState = {
  type: 'raw',
  raw: '',
  rawLanguage: 'json',
  urlEncoded: [],
  formData: [],
  binaryFilePath: '',
}

export function toRestBodyInput(body: BodyState): RestBodyInput {
  switch (body.type) {
    case 'none':
      return { type: 'none' }
    case 'raw':
      return { type: 'raw', content: body.raw, rawLanguage: body.rawLanguage }
    case 'urlencoded':
      return {
        type: 'urlencoded',
        fields: body.urlEncoded.map(({ name, value, enabled }) => ({ name, value, enabled })),
      }
    case 'formData':
      return {
        type: 'formData',
        fields: body.formData.map((entry) =>
          entry.kind === 'file'
            ? { kind: 'file', name: entry.name, enabled: entry.enabled, filePath: entry.filePath }
            : { kind: 'text', name: entry.name, enabled: entry.enabled, value: entry.value },
        ),
      }
    case 'binary':
      return { type: 'binary', filePath: body.binaryFilePath }
  }
}

export function toBodyState(input: RestBodyInput): BodyState {
  switch (input.type) {
    case 'none':
      return { ...emptyBodyState, type: 'none' }
    case 'raw':
      return { ...emptyBodyState, raw: input.content, rawLanguage: input.rawLanguage }
    case 'urlencoded':
      return {
        ...emptyBodyState,
        type: 'urlencoded',
        urlEncoded: input.fields.map((field) => ({ id: nextBodyRowId(), ...field })),
      }
    case 'formData':
      return {
        ...emptyBodyState,
        type: 'formData',
        formData: input.fields.map((field) => ({
          id: nextBodyRowId(),
          name: field.name,
          enabled: field.enabled,
          kind: field.kind,
          value: field.kind === 'text' ? field.value : '',
          filePath: field.kind === 'file' ? field.filePath : '',
        })),
      }
    case 'binary':
      return { ...emptyBodyState, type: 'binary', binaryFilePath: input.filePath }
  }
}

/** Corpo REST vindo de um DTO de coleção/histórico: DTOs antigos só têm o
 * texto (`body`), tratado como raw JSON. */
export function restBodyFromDto(restBody: RestBodyInput | null | undefined, body: string): RestBodyInput {
  return restBody ?? { type: 'raw', content: body, rawLanguage: 'json' }
}

/** Texto que vai no campo `body` do DTO de coleção (legado/informativo): o
 * conteúdo raw; vazio para os demais tipos — o corpo real está em `restBody`. */
export function restBodyText(body: RestBodyInput): string {
  return body.type === 'raw' ? body.content : ''
}

export function sameRestBody(a: RestBodyInput, b: RestBodyInput): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function codeLanguageForRaw(language: RawBodyLanguage): CodeLanguage {
  return language === 'text' ? 'none' : language
}

const RAW_CONTENT_TYPES: Record<RawBodyLanguage, string> = {
  text: 'text/plain',
  javascript: 'application/javascript',
  json: 'application/json',
  html: 'text/html',
  xml: 'application/xml',
}

const URL_ENCODED_CONTENT_TYPE = 'application/x-www-form-urlencoded'
const BINARY_CONTENT_TYPE = 'application/octet-stream'

/** Valores que a própria sincronização escreve — só eles são trocados ou
 * removidos automaticamente; um `Content-Type` digitado pelo usuário
 * (ex.: `application/vnd.api+json`) é preservado. */
const AUTOMATIC_CONTENT_TYPES = new Set([
  ...Object.values(RAW_CONTENT_TYPES),
  URL_ENCODED_CONTENT_TYPE,
  BINARY_CONTENT_TYPE,
  'multipart/form-data',
])

/** `Content-Type` que o tipo de corpo pede; `null` = nenhum header (sem
 * corpo, ou form-data, cujo header com boundary é gerado pelo backend). */
export function contentTypeFor(type: BodyType, rawLanguage: RawBodyLanguage): string | null {
  switch (type) {
    case 'raw':
      return RAW_CONTENT_TYPES[rawLanguage]
    case 'urlencoded':
      return URL_ENCODED_CONTENT_TYPE
    case 'binary':
      return BINARY_CONTENT_TYPE
    case 'none':
    case 'formData':
      return null
  }
}

function isContentType(header: HeaderEntry): boolean {
  return header.name.trim().toLowerCase() === 'content-type'
}

function isAutomatic(header: HeaderEntry): boolean {
  return header.value.trim() === '' || AUTOMATIC_CONTENT_TYPES.has(header.value.trim().toLowerCase())
}

/** Ajusta a linha `Content-Type` da grade de headers ao tipo de corpo:
 * atualiza/remove só linhas com valor automático, e cria uma quando não há
 * nenhuma. Headers personalizados pelo usuário nunca são sobrescritos. */
export function syncContentTypeHeader(
  headers: HeaderEntry[],
  contentType: string | null,
  newId: () => string,
): HeaderEntry[] {
  const existing = headers.find(isContentType)
  if (existing && !isAutomatic(existing)) return headers

  if (contentType === null) {
    return existing ? headers.filter((header) => header !== existing) : headers
  }
  if (!existing) {
    return [...headers, { id: newId(), name: 'Content-Type', value: contentType, enabled: true }]
  }
  if (existing.value === contentType) return headers
  return headers.map((header) => (header === existing ? { ...header, value: contentType } : header))
}

export function emptyUrlEncodedEntry(): UrlEncodedEntry {
  return { id: nextBodyRowId(), name: '', value: '', enabled: true }
}

export function emptyFormDataEntry(): FormDataEntry {
  return { id: nextBodyRowId(), name: '', enabled: true, kind: 'text', value: '', filePath: '' }
}

/** Nome do arquivo (sem diretório) para exibir um caminho absoluto em
 * Windows ou Unix. */
export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** Representação em texto do corpo para o console/HAR (o corpo multipart ou
 * binário real só existe no backend). Arquivos aparecem como `@caminho`, a
 * mesma notação do `curl`. */
export function bodyPreviewText(body: BodyState): string {
  switch (body.type) {
    case 'none':
      return ''
    case 'raw':
      return body.raw
    case 'urlencoded': {
      const params = new URLSearchParams()
      for (const field of body.urlEncoded) if (field.enabled && field.name) params.append(field.name, field.value)
      return params.toString()
    }
    case 'formData':
      return body.formData
        .filter((field) => field.enabled && field.name)
        .map((field) => `${field.name}=${field.kind === 'file' ? `@${field.filePath}` : field.value}`)
        .join('\n')
    case 'binary':
      return body.binaryFilePath ? `@${body.binaryFilePath}` : ''
  }
}

const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/

/** `true` para caminhos absolutos em Unix (`/…`), Windows (`C:\…`) ou rede (`\\…`). */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || WINDOWS_DRIVE.test(path)
}

/** Converte um arquivo escolhido dentro do workspace em caminho relativo,
 * com `/` como separador — portável entre máquinas e sistemas e sem expor
 * a estrutura de pastas local numa coleção versionada. Arquivos fora do
 * workspace continuam absolutos. */
export function toWorkspaceRelativePath(path: string, rootPath: string): string {
  if (!rootPath) return path
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '')
  const root = normalize(rootPath)
  const file = normalize(path)
  // Windows compara caminhos sem diferenciar maiúsculas; Unix diferencia.
  const caseInsensitive = WINDOWS_DRIVE.test(rootPath)
  const prefix = `${root}/`
  const matches = caseInsensitive ? file.toLowerCase().startsWith(prefix.toLowerCase()) : file.startsWith(prefix)
  return matches ? file.slice(prefix.length) : path
}

/** Caminhos de arquivo que o corpo ativo vai ler ao enviar. */
export function bodyFilePaths(body: BodyState): string[] {
  if (body.type === 'binary') return body.binaryFilePath ? [body.binaryFilePath] : []
  if (body.type === 'formData') {
    return body.formData.filter((field) => field.kind === 'file' && field.filePath).map((field) => field.filePath)
  }
  return []
}
