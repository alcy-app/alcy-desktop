import { Button } from '../../shared/ui/Button'
import { IconButton } from '../../shared/ui/IconButton'
import { SaveIcon, DownloadIcon, RefreshIcon, TrashIcon, PlusIcon } from '../../shared/ui/icons'
import { Modal } from '../../shared/ui/Modal'
import { useEffect, useState } from 'react'
import { documentCall, documentImageUrl, type DocumentSource, type DocumentSourceList } from '../../bindings/documentation'
import { useLanguage } from '../../shared/i18n/use-language'
import { MarkdownView } from '../notifications/MarkdownView'
import type { DocumentActions, OpenDocument } from './use-documents'
import './documents.css'

function DocumentImage({ rootPath, documentId, assetId, caption }: { rootPath: string; documentId: string; assetId: string; caption: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const { t } = useLanguage()
  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    void documentImageUrl(rootPath, documentId, assetId).then((result) => {
      objectUrl = result
      if (cancelled) URL.revokeObjectURL(result)
      else setUrl(result)
    }).catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [rootPath, documentId, assetId])
  return <span className="document-image">{url ? <img src={url} alt={caption} /> : <span>{t(failed ? 'documents.imageFailed' : 'documents.loading')}</span>}<span className="document-caption">{caption}</span></span>
}

export function DocumentEditor({ document: doc, actions }: { document: OpenDocument; actions: DocumentActions }) {
  const { t } = useLanguage()
  const { rootPath, describeError } = actions
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'edit' | 'split' | 'preview'>('split')
  const [attachments, setAttachments] = useState(false)
  const [sourcePicker, setSourcePicker] = useState(false)
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [choices, setChoices] = useState<DocumentSourceList | null>(null)
  const [caption, setCaption] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmReload, setConfirmReload] = useState(false)
  const run = async (work: () => Promise<unknown>) => {
    setError(null); setBusy(true)
    try { await work() } catch (e) { if (!(e instanceof Error && e.name === 'cancelled')) setError(actions.describeError(e)) } finally { setBusy(false) }
  }
  useEffect(() => {
    if (!sourcePicker) return
    let cancelled = false
    void documentCall<DocumentSourceList>(rootPath, 'sources', { query, offset }).then((value) => { if (!cancelled) setChoices(value) }).catch((e: unknown) => { if (!cancelled) setError(describeError(e)) })
    return () => { cancelled = true }
  }, [sourcePicker, query, offset, rootPath, describeError])
  const toggleSource = (source: DocumentSource) => {
    const selected = doc.saved.sources.some((s) => s.id === source.id && s.kind === source.kind)
    return actions.selectSources(doc.saved.id, doc.saved.revision, selected ? doc.saved.sources.filter((s) => s.id !== source.id || s.kind !== source.kind) : [...doc.saved.sources, source])
  }
  return <section className="document-editor" aria-label={t('documents.editor')}>
    <header className="document-header">
      <div className="document-heading">
        <span className="document-eyebrow">{t('documents.label')}</span>
        <input className="document-title" aria-label={t('documents.title')} value={doc.title} maxLength={240} onChange={(e) => actions.edit(doc.saved.id, { title: e.target.value })} />
        <span className="document-status" role="status">{t(doc.dirty ? 'documents.unsaved' : 'documents.saved')}</span>
      </div>
      <div className="document-actions">
        <Button disabled={busy || !doc.dirty} onClick={() => void run(() => actions.save(doc.saved.id))}><SaveIcon size={14} />{t('documents.save')}</Button>
        <div className="document-export" role="group" aria-label={t('documents.export')} title={doc.dirty ? t('documents.saveFirst') : undefined}>
          <DownloadIcon size={14} />
          <button disabled={busy || doc.dirty} onClick={() => void run(() => actions.exportFile(doc.saved.id, 'md'))}>Markdown</button>
          <button disabled={busy || doc.dirty} onClick={() => void run(() => actions.exportFile(doc.saved.id, 'pdf'))}>PDF</button>
        </div>
        <IconButton icon={<RefreshIcon size={14} />} label={t('documents.reload')} disabled={busy} onClick={() => setConfirmReload(true)} />
        <IconButton icon={<TrashIcon size={14} />} label={t('documents.delete')} variant="danger" disabled={busy || doc.dirty} onClick={() => setConfirmDelete(true)} />
      </div>
    </header>
    <div className="document-toolbar">
      <div className="document-view-switch" role="group" aria-label={t('documents.view')}>
        {(['edit', 'split', 'preview'] as const).map((mode) => <button key={mode} aria-pressed={view === mode} onClick={() => setView(mode)}>{t(`documents.${mode}`)}</button>)}
      </div>
      <div className="document-toolbar-tools">
        <button disabled={busy || doc.dirty} aria-expanded={sourcePicker} onClick={() => setSourcePicker((shown) => !shown)}>{t('documents.sources')} <span className="document-count">{doc.saved.sources.length}</span></button>
        <button aria-expanded={attachments} onClick={() => setAttachments((shown) => !shown)}><PlusIcon size={13} />{t('documents.images')}</button>
      </div>
    </div>
    {doc.dirty && <p className="document-notice">{t('documents.saveFirst')}</p>}
    {error && <p role="alert" className="document-notice">{error}</p>}
    {busy && <p role="status" className="document-notice">{t('documents.working')}{actions.job && <button onClick={actions.cancelExport}>{t('documents.cancel')}</button>}</p>}
    {confirmDelete && <Modal title={t('documents.delete')} closeAriaLabel={t('documents.cancel')} onClose={() => setConfirmDelete(false)}><p>{t('documents.deleteConfirm')}</p><div className="document-dialog-actions"><Button variant="danger" onClick={() => { setConfirmDelete(false); void run(() => actions.remove(doc.saved.id, doc.saved.revision)) }}>{t('documents.delete')}</Button><Button variant="ghost" onClick={() => setConfirmDelete(false)}>{t('documents.cancel')}</Button></div></Modal>}
    {confirmReload && <Modal title={t('documents.reload')} closeAriaLabel={t('documents.cancel')} onClose={() => setConfirmReload(false)}><p>{t('documents.reloadConfirm')}</p><div className="document-dialog-actions"><Button onClick={() => { setConfirmReload(false); void run(() => actions.discard(doc.saved.id)) }}>{t('documents.reload')}</Button><Button variant="ghost" onClick={() => setConfirmReload(false)}>{t('documents.cancel')}</Button></div></Modal>}
    {sourcePicker && <div className="document-sources">
      <p>{t('documents.sourcesHelp')}</p>
      {doc.saved.sources.map((source) => <label key={`selected:${source.kind}:${source.id}`}><input type="checkbox" checked disabled={busy || doc.dirty} onChange={() => void run(() => toggleSource(source))} />{source.label}{source.atMs && <small> · {new Date(source.atMs).toLocaleString()}</small>}</label>)}
      <input aria-label={t('documents.searchSources')} placeholder={t('documents.searchSources')} value={query} onChange={(e) => { setQuery(e.target.value); setOffset(0) }} />
      {choices === null ? <p>{t('documents.loading')}</p> : choices.sources.length === 0 ? <p>{t('documents.noSources')}</p> : choices.sources.map((source) => <label key={`${source.kind}:${source.id}`}><input type="checkbox" disabled={busy || doc.dirty} checked={doc.saved.sources.some((s) => s.id === source.id && s.kind === source.kind)} onChange={() => void run(() => toggleSource(source))} />{t(source.kind === 'chat' ? 'documents.conversation' : 'documents.request')} · {source.label}{source.atMs && <small> · {new Date(source.atMs).toLocaleString()}</small>}</label>)}
      <div><button disabled={offset === 0 || busy} onClick={() => setOffset(Math.max(0, offset - 25))}>{t('documents.previous')}</button><button disabled={choices?.nextOffset == null || busy} onClick={() => setOffset(choices?.nextOffset ?? 0)}>{t('documents.next')}</button></div>
    </div>}
    {attachments && <div className="document-attachments">
      <label className="document-field">{t('documents.caption')}
      <input aria-label={t('documents.caption')} placeholder={t('documents.caption')} value={caption} maxLength={500} onChange={(e) => setCaption(e.target.value)} /></label>
      <button disabled={busy || doc.dirty || !caption.trim()} onClick={() => void run(() => actions.importImage(doc.saved.id, doc.saved.revision, caption))}>{t('documents.attachImage')}</button>
      {doc.saved.sources.filter((s) => s.kind === 'request').map((source) => <button key={source.id} title={source.label} disabled={busy || doc.dirty || !caption.trim()} onClick={() => void run(() => actions.captureImage(doc.saved.id, doc.saved.revision, caption, { sourceId: source.id }))}>{t('documents.capture')} · {source.label}</button>)}
    </div>}
    <div className={`document-split document-split--${view}`}>
      {view !== 'preview' && <div className="document-code-pane"><div className="document-pane-heading">Markdown <span>{t('documents.saveShortcut')}</span></div>
      <textarea aria-label={t('documents.markdown')} value={doc.markdown} spellCheck={false} onChange={(e) => actions.edit(doc.saved.id, { markdown: e.target.value })} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); if (!busy) void run(() => actions.save(doc.saved.id)) } }} />
      </div>}
      {view !== 'edit' && <div className="document-preview-pane"><div className="document-pane-heading">{t('documents.preview')}</div><div className="document-preview" aria-label={t('documents.preview')}><MarkdownView source={doc.markdown} renderImage={(assetId, caption) => <DocumentImage key={assetId} rootPath={actions.rootPath} documentId={doc.saved.id} assetId={assetId} caption={caption} />} /></div></div>}
    </div>
    <footer><span>{t('documents.local')}</span><span>{t('documents.revision', { revision: doc.saved.revision })}</span></footer>
  </section>
}
