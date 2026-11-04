import { useMemo, useRef, useState } from 'react'
import type { DocumentationRecord } from '../../bindings/documentation'
import { useLanguage } from '../../shared/i18n/use-language'
import { comboFromEvent, isShortcutFor } from '../../shared/shortcuts/shortcuts'
import { useShortcuts } from '../../shared/shortcuts/use-shortcuts'
import { Button } from '../../shared/ui/Button'
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog'
import { EmptyState } from '../../shared/ui/EmptyState'
import { IconButton } from '../../shared/ui/IconButton'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { InlineEditInput } from '../../shared/ui/InlineEditInput'
import { LoadingBar } from '../../shared/ui/LoadingBar'
import { MenuItem, MenuSeparator, OptionsMenu } from '../../shared/ui/Menu'
import { useToast } from '../../shared/ui/use-toast'
import { CloseIcon, DocumentIcon, DownloadIcon, PlusIcon, RefreshIcon, SearchIcon, SortDescendingIcon } from '../../shared/ui/icons'
import { MentionInChatMenuItem } from '../agent/MentionInChatMenuItem'
import { VirtualizedList, type VirtualizedListHandle } from '../request-workbench/components/VirtualizedList'
import { formatRelativeTime } from './document-format'
import type { DocumentsManager } from './use-documents'
import './documents.css'

type Sort = 'updated' | 'title' | 'created'
const SORTS: Record<Sort, (a: DocumentationRecord, b: DocumentationRecord) => number> = {
  updated: (a, b) => b.updatedAtMs - a.updatedAtMs,
  created: (a, b) => b.createdAtMs - a.createdAtMs,
  title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }),
}

export function DocumentsPanel({ manager }: { manager: DocumentsManager }) {
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const { bindings } = useShortcuts()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('updated')
  const [menuKey, setMenuKey] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<DocumentationRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<VirtualizedListHandle>(null)
  const rowButtons = useRef(new Map<string, HTMLButtonElement>())

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await work() } catch (e) { if (!(e instanceof Error && e.name === 'cancelled')) setError(manager.describeError(e)) } finally { setBusy(false) }
  }
  const open = useMemo(() => new Map(manager.opened.map((d) => [d.saved.id, d])), [manager.opened])
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return manager.documents.filter((doc) => doc.title.toLowerCase().includes(needle)).sort(SORTS[sort])
  }, [manager.documents, query, sort])

  const create = () => void run(() => manager.create(t('documents.untitled'), true))
  const focusRow = (id: string) => requestAnimationFrame(() => rowButtons.current.get(id)?.focus())
  const finishRename = (commit: boolean) => {
    if (!renaming) return
    const { id, draft } = renaming
    setRenaming(null)
    focusRow(id)
    if (commit && draft.trim()) void run(() => manager.rename(id, draft))
  }
  const exportAs = (doc: DocumentationRecord, format: 'md' | 'pdf') => {
    setMenuKey(null)
    void run(async () => {
      const result = await manager.exportFile(doc.id, format)
      if (!(result && typeof result === 'object' && 'cancelled' in result)) showToast(t('documents.exported'))
    })
  }
  const sortLabels: Record<Sort, string> = { updated: t('documents.sort.updated'), title: t('documents.sort.title'), created: t('documents.sort.created') }

  const toolbar = <div className="documents-toolbar sidebar-panel-toolbar">
    <div className="document-search">
      <SearchIcon size={12} className="document-search-icon" />
      <input type="text" className="document-search-input ui-input" value={query} placeholder={t('documents.search')} aria-label={t('documents.search')}
        onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery('') } }} />
      {query && <IconButton className="document-search-clear" icon={<CloseIcon size={11} />} label={t('documents.clearSearch')} onClick={() => setQuery('')} />}
    </div>
    <OptionsMenu label={t('documents.sort.label')} icon={<SortDescendingIcon size={13} />} isOpen={menuKey === 'sort'}
      onToggle={() => setMenuKey((key) => key === 'sort' ? null : 'sort')} onClose={() => setMenuKey(null)} menuPortal>
      {(Object.keys(sortLabels) as Sort[]).map((value) => <MenuItem key={value} label={sortLabels[value]} selected={sort === value} onSelect={() => { setSort(value); setMenuKey(null) }} />)}
      <MenuSeparator />
      <MenuItem icon={<RefreshIcon size={13} />} label={t('documents.refresh')} disabled={busy} onSelect={() => { setMenuKey(null); void run(manager.refresh) }} />
    </OptionsMenu>
    <IconButton icon={<PlusIcon size={13} />} label={t('documents.new')} disabled={busy} onClick={create} />
  </div>

  const status = <>
    {(error || manager.error) && <InlineAlert className="documents-alert">{error ?? manager.error}</InlineAlert>}
    {manager.job && <div className="documents-job" role="status"><LoadingBar /><span>{t('documents.working')}</span><Button variant="ghost" onClick={manager.cancelJob}>{t('documents.cancel')}</Button></div>}
  </>

  const dialog = pendingDelete && <ConfirmDialog title={t('documents.deleteDocument')} description={t('documents.deleteNamedConfirm', { title: pendingDelete.title })}
    confirmLabel={t('documents.delete')} cancelLabel={t('documents.cancel')} closeAriaLabel={t('documents.cancel')}
    onCancel={() => setPendingDelete(null)}
    onConfirm={() => { const doc = pendingDelete; setPendingDelete(null); void run(() => manager.remove(doc.id, doc.revision)) }} />

  if (manager.loading) {
    return <div className="documents-panel sidebar-panel-layout">{toolbar}<div className="sidebar-panel-scroll" role="status" aria-label={t('documents.loading')}>
      {[0, 1, 2].map((index) => <div key={index} className="documents-skeleton" aria-hidden="true"><span /><span /></div>)}
    </div></div>
  }
  if (manager.documents.length === 0) {
    return <div className="documents-panel sidebar-panel-layout">{toolbar}{status}<div className="sidebar-panel-scroll">
      <EmptyState icon={<DocumentIcon size={22} />} title={t('documents.emptyTitle')} description={t('documents.emptyHelp')}
        action={<Button disabled={busy} onClick={create}><PlusIcon size={13} />{t('documents.new')}</Button>} />
    </div></div>
  }

  return <div className="documents-panel sidebar-panel-layout">
    {toolbar}
    {status}
    {rows.length === 0
      ? <div className="sidebar-panel-scroll"><EmptyState icon={<SearchIcon size={22} />} title={t('documents.noMatches')} /></div>
      : <VirtualizedList ref={listRef} items={rows} getKey={(doc) => doc.id} estimatedRowHeight={48} className="sidebar-panel-scroll documents-list" ariaLabel={t('documents.label')} renderItem={(doc) => {
        const state = open.get(doc.id)
        const title = state?.title || doc.title
        const meta = [
          formatRelativeTime(doc.updatedAtMs, language),
          ...(doc.sources.length ? [t(doc.sources.length === 1 ? 'documents.sourceCountOne' : 'documents.sourceCount', { count: doc.sources.length })] : []),
          ...(doc.assets.length ? [t(doc.assets.length === 1 ? 'documents.imageCountOne' : 'documents.imageCount', { count: doc.assets.length })] : []),
        ].join(' · ')
        const rowClass = ['documents-row', state?.active ? 'documents-row--active' : null].filter(Boolean).join(' ')
        if (renaming?.id === doc.id) {
          return <div className={`${rowClass} documents-row--renaming`}>
            <DocumentIcon size={14} className="documents-row-icon" />
            <InlineEditInput autoFocus value={renaming.draft} maxLength={240} aria-label={t('documents.renameLabel')}
              onChange={(e) => setRenaming({ id: doc.id, draft: e.target.value })}
              onBlur={() => finishRename(true)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== 'Escape') return
                e.preventDefault(); e.stopPropagation()
                finishRename(e.key === 'Enter')
              }} />
          </div>
        }
        return <div className={rowClass} onContextMenu={(e) => { e.preventDefault(); setMenuKey(doc.id) }}>
          <button type="button" className="documents-row-main" aria-current={state?.active ? 'page' : undefined} disabled={busy}
            ref={(element) => { if (element) rowButtons.current.set(doc.id, element); else rowButtons.current.delete(doc.id) }}
            onClick={() => void run(() => manager.open(doc.id))}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return
              const combo = comboFromEvent(e)
              if (isShortcutFor(bindings, 'renameItem', combo)) { e.preventDefault(); setRenaming({ id: doc.id, draft: title }) }
              else if (isShortcutFor(bindings, 'deleteItem', combo)) { e.preventDefault(); setPendingDelete(doc) }
              else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
                e.preventDefault()
                const index = rows.findIndex((row) => row.id === doc.id)
                const target = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))
                listRef.current?.scrollToKey(rows[target].id)
                focusRow(rows[target].id)
              }
            }}>
            <DocumentIcon size={14} className="documents-row-icon" />
            <span className="documents-row-text">
              <span className="documents-row-title">{title}</span>
              <span className="documents-row-meta">{meta}</span>
            </span>
            {state?.dirty && <span className="documents-row-dirty" role="img" aria-label={t('documents.unsaved')} />}
          </button>
          <OptionsMenu label={t('documents.itemActions', { title })} wrapperClassName="documents-row-menu" menuPlacement="auto" menuPortal
            isOpen={menuKey === doc.id} onToggle={() => setMenuKey((key) => key === doc.id ? null : doc.id)} onClose={() => setMenuKey(null)}>
            <MenuItem label={t('documents.open')} onSelect={() => { setMenuKey(null); void run(() => manager.open(doc.id)) }} />
            <MenuItem label={t('documents.rename')} shortcutAction="renameItem" onSelect={() => { setMenuKey(null); setRenaming({ id: doc.id, draft: title }) }} />
            <MentionInChatMenuItem item={{ kind: 'document', id: doc.id, label: title }} onDone={() => setMenuKey(null)} />
            <MenuSeparator />
            <MenuItem icon={<DownloadIcon size={13} />} label={t('documents.exportMarkdown')} disabled={busy || !!state?.dirty} onSelect={() => exportAs(doc, 'md')} />
            <MenuItem icon={<DownloadIcon size={13} />} label={t('documents.exportPdf')} disabled={busy || !!state?.dirty} onSelect={() => exportAs(doc, 'pdf')} />
            <MenuSeparator />
            <MenuItem label={t('documents.delete')} shortcutAction="deleteItem" danger disabled={busy || !!state?.dirty} onSelect={() => { setMenuKey(null); setPendingDelete(doc) }} />
          </OptionsMenu>
        </div>
      }} />}
    {dialog}
  </div>
}
