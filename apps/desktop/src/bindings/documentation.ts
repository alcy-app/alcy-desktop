import { invokeResult } from './invoke-result'
import { open, save } from '@tauri-apps/plugin-dialog'

export interface DocumentSource { kind: 'chat' | 'request'; id: string; label: string; atMs?: number }
export interface DocumentAsset { id: string; caption: string }
export interface DocumentationRecord {
  version: number; id: string; title: string; revision: number; createdAtMs: number; updatedAtMs: number
  sources: DocumentSource[]; assets: DocumentAsset[]; markdown: string
}
export interface DocumentPage { text: string; nextOffset: number | null; totalBytes: number }
export interface DocumentRead { document: DocumentationRecord; page: DocumentPage }
export interface DocumentList { documents: DocumentationRecord[]; nextOffset: number | null }
export interface DocumentSourceList { sources: DocumentSource[]; nextOffset: number | null }
export interface DocumentationError { kind: 'invalid' | 'notFound' | 'conflict' | 'cancelled' | 'storage'; message?: string }

export async function documentCall<T>(rootPath: string, operation: string, input: Record<string, unknown> = {}): Promise<T> {
  const result = await invokeResult<T, DocumentationError>('documentation', { input: { ...input, rootPath, operation } })
  if (!result.ok) {
    const error = new Error(result.error.message ?? result.error.kind)
    error.name = result.error.kind
    throw error
  }
  return result.value
}
export function cancelDocumentJob(jobId: string) { return invokeResult<void, DocumentationError>('cancel_documentation_job', { jobId }) }
export async function readDocument(rootPath: string, documentId: string): Promise<DocumentationRecord> {
  let offset = 0
  let markdown = ''
  let revision: number | null = null
  for (;;) {
    const read = await documentCall<DocumentRead>(rootPath, 'get', { documentId, offset })
    if (revision !== null && revision !== read.document.revision) throw new Error('conflict')
    revision = read.document.revision
    markdown += read.page.text
    if (read.page.nextOffset === null) return { ...read.document, markdown }
    offset = read.page.nextOffset
  }
}
export async function documentImageUrl(rootPath: string, documentId: string, assetId: string): Promise<string> {
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  for (;;) {
    const page = await documentCall<{ bytes: number[]; nextOffset: number | null }>(rootPath, 'asset', { documentId, assetId, offset })
    chunks.push(new Uint8Array(page.bytes))
    if (page.nextOffset === null) return URL.createObjectURL(new Blob(chunks, { type: 'image/png' }))
    offset = page.nextOffset
  }
}
export async function uploadDocumentImage(rootPath: string, documentId: string, revision: number, caption: string, blob: Blob, cancelled: () => boolean = () => false, jobId = crypto.randomUUID()) {
  try {
    if (blob.size > 8 * 1024 * 1024) throw new Error('Image exceeds 8 MiB.')
    for (let offset = 0; offset < blob.size; offset += 64 * 1024) {
      if (cancelled()) {
        const error = new Error('Cancelled.')
        error.name = 'cancelled'
        throw error
      }
      const end = Math.min(offset + 64 * 1024, blob.size)
      await documentCall(rootPath, 'imageChunk', { documentId, revision, caption, jobId, offset, finalChunk: end === blob.size, bytes: [...new Uint8Array(await blob.slice(offset, end).arrayBuffer())] })
    }
  } finally { await cancelDocumentJob(jobId) }
}
/** Stage bounded chunks natively; only the last chunk commits the new revision. */
export async function saveDocumentContent(rootPath: string, documentId: string, revision: number, title: string, markdown: string): Promise<DocumentationRecord> {
  const jobId = crypto.randomUUID()
  const bytes = new TextEncoder().encode(markdown)
  if (bytes.length > 1024 * 1024) throw new Error('The document exceeds 1 MiB.')
  try {
    let saved: DocumentationRecord | null = null
    for (let offset = 0; offset === 0 || offset < bytes.length; offset += 32 * 1024) {
      const end = Math.min(offset + 32 * 1024, bytes.length)
      const result = await documentCall<DocumentationRecord>(rootPath, 'contentChunk', { documentId, revision, title, jobId, offset, finalChunk: end === bytes.length, bytes: [...bytes.slice(offset, end)] })
      if (end === bytes.length) { saved = result; break }
    }
    if (!saved) throw new Error('Incomplete save.')
    return saved
  } finally { await cancelDocumentJob(jobId) }
}
export async function pickDocumentImage(): Promise<string | null> {
  const result = await open({ multiple: false, directory: false, filters: [{ name: 'PNG / JPEG', extensions: ['png', 'jpg', 'jpeg'] }] })
  return typeof result === 'string' ? result : null
}
export async function pickDocumentExport(title: string, format: 'pdf' | 'md'): Promise<string | null> {
  return save({ defaultPath: `${title.replace(/[<>:"/\\|?*]/g, '_')}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] })
}
