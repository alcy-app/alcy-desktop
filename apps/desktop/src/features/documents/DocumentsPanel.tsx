import { useState } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { IconButton } from '../../shared/ui/IconButton'
import { PlusIcon, RefreshIcon, SearchIcon, CloseIcon } from '../../shared/ui/icons'
import type { DocumentsManager } from './use-documents'
import './documents.css'

export function DocumentsPanel({ manager }: { manager: DocumentsManager }) {
  const { t } = useLanguage()
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (work: () => Promise<unknown>) => { setBusy(true); setError(null); try { await work() } catch (e) { setError(manager.describeError(e)) } finally { setBusy(false) } }
  const matches = manager.documents.filter((doc) => doc.title.toLowerCase().includes(query.toLowerCase()))
  return <div className="documents-panel">
    <div className="documents-panel-heading"><span>{t('documents.label')} <span className="document-count">{manager.documents.length}</span></span><div>
      <IconButton icon={<RefreshIcon size={14} />} label={t('documents.refresh')} disabled={busy} onClick={() => void run(manager.refresh)} />
      <IconButton icon={<PlusIcon size={15} />} label={t('documents.new')} aria-expanded={creating} onClick={() => setCreating(!creating)} />
    </div></div>
    <div className="documents-search"><SearchIcon size={14} /><input aria-label={t('documents.search')} placeholder={t('documents.search')} value={query} onChange={(e) => { setQuery(e.target.value); setOffset(0) }} /></div>
    {creating && <form className="documents-create" onSubmit={(e) => { e.preventDefault(); void run(async () => { await manager.create(title); setTitle(''); setCreating(false) }) }}>
      <label>{t('documents.newTitle')}<input autoFocus aria-label={t('documents.newTitle')} value={title} maxLength={240} onChange={(e) => setTitle(e.target.value)} /></label>
      <div><Button disabled={busy || !title.trim()} type="submit">{t('documents.create')}</Button><IconButton icon={<CloseIcon size={14} />} label={t('documents.close')} onClick={() => setCreating(false)} /></div>
    </form>}
    {(error || manager.error) && <p role="alert" className="document-notice">{error ?? manager.error}</p>}
    {manager.loading ? <p className="documents-empty" role="status">{t('documents.loading')}</p> : matches.length === 0 ? <div className="documents-empty"><strong>{t(query ? 'documents.noMatches' : 'documents.emptyTitle')}</strong>{!query && <><p>{t('documents.emptyHelp')}</p><Button variant="ghost" onClick={() => setCreating(true)}><PlusIcon size={14} />{t('documents.new')}</Button></>}</div> : <ul className="documents-list">{matches.slice(offset, offset + 25).map((doc) => <li key={doc.id}><button disabled={busy} onClick={() => void run(() => manager.open(doc.id))}><span className="documents-list-title">{doc.title}</span><span className="documents-list-meta">{t('documents.updated')} {new Date(doc.updatedAtMs).toLocaleDateString()}<span>{t('documents.revision', { revision: doc.revision })}</span></span></button></li>)}</ul>}
    {matches.length > 25 && <div className="documents-pagination"><Button variant="ghost" disabled={offset === 0 || busy} onClick={() => setOffset(Math.max(0, offset - 25))}>{t('documents.previous')}</Button><Button variant="ghost" disabled={offset + 25 >= matches.length || busy} onClick={() => setOffset(offset + 25)}>{t('documents.next')}</Button></div>}
    {manager.job && <div role="status" className="document-notice"><span>{t('documents.working')}</span><Button variant="ghost" onClick={manager.cancelJob}>{t('documents.cancel')}</Button></div>}
  </div>
}
