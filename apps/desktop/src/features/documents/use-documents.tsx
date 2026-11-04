import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cancelDocumentJob, documentCall, listDocumentThemes, pickDocumentExport, pickDocumentImage, readDocument, saveDocumentContent, uploadDocumentImage, type DocumentationRecord, type DocumentList, type DocumentRead, type DocumentSource, type DocumentThemeSummary } from '../../bindings/documentation'
import type { PseudoTab } from '../../extensions/types'
import { useLanguage } from '../../shared/i18n/use-language'
import type { WorkbenchAgentHost } from '../agent/agent-host'
import { redactResource, resourceSecrets } from '../agent/agent-resource-data'
import { rememberedSession } from '../agent/agent-session-memory'
import type { AgentDocumentHost } from './document-agent-tools'
import { captureDocumentRequest } from './document-screenshot'
import { DocumentEditor } from './DocumentEditor'

export interface OpenDocument {
  saved: DocumentationRecord; title: string; markdown: string; dirty: boolean; active: boolean
  /** Created from the panel and not edited yet: the editor focuses the title. */
  justCreated?: boolean
}
export function useDocuments(rootPath: string) {
  const { t, language } = useLanguage()
  const [documents, setDocuments] = useState<DocumentationRecord[]>([])
  const [opened, setOpened] = useState<OpenDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<string | null>(null)
  const [themes, setThemes] = useState<DocumentThemeSummary[]>([])
  useEffect(() => {
    let cancelled = false
    void listDocumentThemes(rootPath).then((value) => { if (!cancelled) setThemes(value) }).catch(() => {})
    return () => { cancelled = true }
  }, [rootPath])
  const activeJob = useRef<string | null>(null)
  const cancelEpoch = useRef(0)
  const cancelExport = useCallback(() => { cancelEpoch.current += 1; if (activeJob.current) void cancelDocumentJob(activeJob.current) }, [])
  const current = useRef({ rootPath, opened, t })
  useLayoutEffect(() => { current.current = { rootPath, opened, t } })
  const changeOpened = useCallback((change: (docs: OpenDocument[]) => OpenDocument[]) => {
    const next = change(current.current.opened)
    current.current = { ...current.current, opened: next }
    setOpened(next)
  }, [])
  const describeError = useCallback((e: unknown) => e instanceof Error && (e.name === 'conflict' || e.message === 'conflict') ? t('documents.conflict') : e instanceof Error ? e.message : t('documents.failed'), [t])
  const refresh = useCallback(async () => {
    const docs: DocumentationRecord[] = []
    let offset = 0
    for (;;) {
      const page = await documentCall<DocumentList>(rootPath, 'list', { offset })
      docs.push(...page.documents)
      if (page.nextOffset === null) break
      offset = page.nextOffset
    }
    if (current.current.rootPath === rootPath) setDocuments(docs)
  }, [rootPath])
  useEffect(() => {
    let cancelled = false
    void refresh().catch((e: unknown) => { if (!cancelled) setError(describeError(e)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [refresh, describeError])
  const ensureClean = useCallback((id: string) => {
    if (current.current.opened.find((d) => d.saved.id === id)?.dirty) throw new Error(current.current.t('documents.saveFirst'))
  }, [])
  const reload = useCallback(async (id: string, activate = false) => {
    const doc = await readDocument(rootPath, id)
    if (current.current.rootPath !== rootPath) throw new Error('The workspace changed.')
    changeOpened((docs) => {
      const previous = docs.find((d) => d.saved.id === id)
      if (previous?.dirty) return docs
      const next = { saved: doc, title: doc.title, markdown: doc.markdown, dirty: false, active: activate || previous?.active || false }
      return [...docs.filter((d) => d.saved.id !== id).map((d) => activate ? { ...d, active: false } : d), next]
    })
    await refresh()
    return doc
  }, [rootPath, changeOpened, refresh])
  const open = useCallback(async (id: string): Promise<boolean> => {
    if (current.current.opened.some((d) => d.saved.id === id)) changeOpened((docs) => docs.map((d) => ({ ...d, active: d.saved.id === id })))
    else await reload(id, true)
    return true
  }, [reload, changeOpened])
  const create = useCallback(async (title: string, focusTitle = false) => {
    const id = crypto.randomUUID()
    let doc = await documentCall<DocumentationRecord>(rootPath, 'create', { documentId: id, title })
    const sessionId = rememberedSession(rootPath)
    if (sessionId) doc = await documentCall<DocumentationRecord>(rootPath, 'selectSources', { documentId: id, revision: doc.revision, sources: [{ kind: 'chat', id: sessionId, label: t('documents.currentChat') }] })
    await reload(id, true)
    if (focusTitle) changeOpened((docs) => docs.map((d) => d.saved.id === id ? { ...d, justCreated: true } : d))
    return doc
  }, [rootPath, reload, changeOpened, t])
  const edit = useCallback((id: string, patch: { title?: string; markdown?: string }) => {
    changeOpened((docs) => docs.map((d) => d.saved.id === id ? { ...d, ...patch, dirty: true, justCreated: false } : d))
  }, [changeOpened])
  /** Renames from the list: an open draft keeps the new title unsaved; otherwise it is saved right away. */
  const rename = useCallback(async (id: string, title: string) => {
    const next = title.trim()
    if (!next) return
    const draft = current.current.opened.find((d) => d.saved.id === id)
    if (draft?.dirty) { if (draft.title !== next) edit(id, { title: next }); return }
    const doc = await readDocument(rootPath, id)
    if (doc.title === next) return
    await saveDocumentContent(rootPath, id, doc.revision, next, doc.markdown)
    if (draft) await reload(id)
    else await refresh()
  }, [rootPath, edit, reload, refresh])
  const save = useCallback(async (id: string) => {
    const draft = current.current.opened.find((d) => d.saved.id === id)
    if (!draft) return
    await saveDocumentContent(rootPath, id, draft.saved.revision, draft.title, draft.markdown)
    const saved = await readDocument(rootPath, id)
    changeOpened((docs) => docs.map((d) => d.saved.id === id ? d.markdown === draft.markdown && d.title === draft.title ? { ...d, saved, title: saved.title, markdown: saved.markdown, dirty: false, justCreated: false } : { ...d, saved, dirty: true } : d))
    await refresh()
  }, [rootPath, changeOpened, refresh])
  const remove = useCallback(async (id: string, revision: number) => {
    ensureClean(id)
    await documentCall(rootPath, 'delete', { documentId: id, revision })
    changeOpened((docs) => docs.filter((d) => d.saved.id !== id)); await refresh()
  }, [rootPath, ensureClean, refresh, changeOpened])
  const selectSources = useCallback(async (id: string, revision: number, sources: DocumentSource[]) => {
    ensureClean(id)
    await documentCall(rootPath, 'selectSources', { documentId: id, revision, sources }); await reload(id)
  }, [rootPath, ensureClean, reload])
  const importImage = useCallback(async (id: string, revision: number, caption: string) => {
    const epoch = cancelEpoch.current
    ensureClean(id)
    const path = await pickDocumentImage()
    if (!path || cancelEpoch.current !== epoch) return
    const jobId = crypto.randomUUID(); activeJob.current = jobId; setJob(jobId)
    try { await documentCall(rootPath, 'importImage', { documentId: id, revision, caption, path, jobId }); await reload(id) }
    finally { activeJob.current = null; setJob(null) }
  }, [rootPath, ensureClean, reload])
  const exportFile = useCallback(async (id: string, format: 'pdf' | 'md', expectedRevision?: number) => {
    const epoch = cancelEpoch.current
    ensureClean(id)
    const doc = await readDocument(rootPath, id)
    if (expectedRevision !== undefined && doc.revision !== expectedRevision) throw new Error(t('documents.conflict'))
    const path = await pickDocumentExport(doc.title, format)
    if (!path || cancelEpoch.current !== epoch) return { cancelled: true }
    const jobId = crypto.randomUUID(); activeJob.current = jobId; setJob(jobId)
    try { return await documentCall(rootPath, 'export', { documentId: id, revision: doc.revision, path, format, jobId, language }) }
    finally { activeJob.current = null; setJob(null) }
  }, [rootPath, ensureClean, t, language])
  const captureImage = useCallback(async (id: string, revision: number, caption: string, input: Parameters<typeof captureDocumentRequest>[2], host: WorkbenchAgentHost | null = null) => {
    const epoch = cancelEpoch.current
    ensureClean(id)
    const doc = await readDocument(rootPath, id)
    if (doc.revision !== revision) throw new Error(t('documents.conflict'))
    const jobId = crypto.randomUUID(); activeJob.current = jobId; setJob(jobId)
    try {
      const blob = await captureDocumentRequest(rootPath, id, input, host, t)
      await uploadDocumentImage(rootPath, id, revision, caption, blob, () => cancelEpoch.current !== epoch, jobId)
      return await reload(id)
    } finally { activeJob.current = null; setJob(null) }
  }, [rootPath, ensureClean, reload, t])
  const agent = useMemo<AgentDocumentHost>(() => ({
    open, cancel: cancelExport,
    context: () => current.current.opened.map((d) => ({ kind: 'document', id: d.saved.id, label: d.title, summary: `Document revision ${d.saved.revision}. Read with get_document.${d.dirty ? ' Has unsaved user edits.' : ''}` })),
    async call(name, input, host: WorkbenchAgentHost) {
      try {
        const id = typeof input.documentId === 'string' ? input.documentId : ''
        const revision = input.expectedRevision
        const secrets = resourceSecrets([host.environments(), host.collections(), host.tabs().map((tab) => tab.content)])
        let value: unknown
        switch (name) {
          case 'get_documentation_guide': value = await documentCall(rootPath, 'guide'); break
          case 'list_documents': value = await documentCall(rootPath, 'list', { query: input.query ?? '', offset: input.offset ?? 0 }); break
          case 'get_document': {
            ensureClean(id)
            const read = await documentCall<DocumentRead>(rootPath, 'get', { documentId: id, offset: input.offset ?? 0 })
            const sourceOffset = Math.max(0, Number(input.sourceOffset) || 0)
            const assetOffset = Math.max(0, Number(input.assetOffset) || 0)
            value = { ...read, document: { ...read.document, sources: read.document.sources.slice(sourceOffset, sourceOffset + 3), assets: read.document.assets.slice(assetOffset, assetOffset + 3) }, nextSourceOffset: sourceOffset + 3 < read.document.sources.length ? sourceOffset + 3 : null, nextAssetOffset: assetOffset + 3 < read.document.assets.length ? assetOffset + 3 : null }
            break
          }
          case 'get_document_outline': {
            ensureClean(id)
            value = await documentCall(rootPath, 'outline', { documentId: id })
            break
          }
          case 'create_document': value = await create(String(input.title ?? '')); break
          case 'open_document': value = { opened: await open(id) }; break
          case 'update_document': {
            ensureClean(id)
            const patch = redactResource({ title: input.title, append: input.append, replaceText: input.replaceText, replacement: input.replacement, section: input.section, sectionEdit: input.sectionEdit, content: input.content, metadata: input.metadata }, secrets) as Record<string, unknown>
            value = await documentCall(rootPath, 'update', { documentId: id, revision, edit: patch }); await reload(id); break
          }
          case 'delete_document': await remove(id, Number(revision)); value = { deleted: true }; break
          case 'read_document_source': value = await documentCall(rootPath, 'readSource', { documentId: id, sourceKind: input.sourceKind, sourceId: input.sourceId, offset: input.offset ?? 0 }); break
          case 'add_document_image': {
            const caption = String(redactResource(String(input.caption ?? ''), secrets))
            value = await captureImage(id, Number(revision), caption, { sourceId: input.sourceId as string | undefined, tabId: input.tabId as string | undefined, target: input.target as 'request' | 'response' | 'both' | undefined }, host)
            break
          }
          case 'export_document': value = await exportFile(id, input.format === 'md' ? 'md' : 'pdf', Number(input.expectedRevision)); break
          default: throw new Error('Unknown document tool.')
        }
        // Never send the full document or image bytes back through the agent transcript.
        if (value && typeof value === 'object' && 'markdown' in value) {
          const record = value as DocumentationRecord
          value = { documentId: record.id, title: record.title, revision: record.revision, sourceCount: record.sources.length, assetCount: record.assets.length }
        }
        return { content: JSON.stringify(redactResource(value, secrets)), isError: false }
      } catch (e) { return { content: describeError(e), isError: true } }
    },
  }), [rootPath, open, ensureClean, create, reload, remove, exportFile, describeError, cancelExport, captureImage])
  const discard = useCallback(async (id: string) => {
    const fresh = await readDocument(rootPath, id)
    changeOpened((docs) => docs.map((d) => d.saved.id === id ? { ...d, saved: fresh, title: fresh.title, markdown: fresh.markdown, dirty: false } : d))
  }, [rootPath, changeOpened])
  const actions = useMemo(() => ({ rootPath, edit, save, remove, selectSources, importImage, exportFile, describeError, reload, discard, job, cancelExport, captureImage, themes }), [rootPath, edit, save, remove, selectSources, importImage, exportFile, describeError, reload, discard, job, cancelExport, captureImage, themes])
  const tabs = useMemo<PseudoTab[]>(() => opened.map((doc) => ({
    id: `document:${doc.saved.id}`, label: doc.title, dirty: doc.dirty, active: doc.active, capturesInput: true,
    activate: () => changeOpened((docs) => docs.map((d) => ({ ...d, active: d.saved.id === doc.saved.id }))),
    deactivate: () => changeOpened((docs) => docs.map((d) => d.saved.id === doc.saved.id ? { ...d, active: false } : d)),
    close: () => changeOpened((docs) => docs.filter((d) => d.saved.id !== doc.saved.id)),
    content: <DocumentEditor key={doc.saved.id} document={doc} actions={actions} />,
  })), [opened, actions, changeOpened])
  const cancelJob = cancelExport
  return useMemo(() => ({ documents, opened, tabs, agent, create, open, rename, remove, exportFile, refresh, loading, error, describeError, job, cancelJob }), [documents, opened, tabs, agent, create, open, rename, remove, exportFile, refresh, loading, error, describeError, job, cancelJob])
}
export type DocumentsManager = ReturnType<typeof useDocuments>
export type DocumentActions = { themes: DocumentThemeSummary[]; captureImage: (id: string, revision: number, caption: string, input: Parameters<typeof captureDocumentRequest>[2], host?: WorkbenchAgentHost | null) => Promise<DocumentationRecord>; job: string | null; cancelExport: () => void; discard: (id: string) => Promise<void>; rootPath: string; edit: (id: string, patch: { title?: string; markdown?: string }) => void; save: (id: string) => Promise<void>; remove: (id: string, revision: number) => Promise<void>; selectSources: (id: string, revision: number, sources: DocumentSource[]) => Promise<void>; importImage: (id: string, revision: number, caption: string) => Promise<void>; exportFile: (id: string, format: 'pdf' | 'md') => Promise<unknown>; describeError: (error: unknown) => string; reload: (id: string, activate?: boolean) => Promise<DocumentationRecord> }
