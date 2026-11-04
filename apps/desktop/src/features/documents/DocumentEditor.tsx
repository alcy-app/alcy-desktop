import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { formatCombo } from '../../shared/shortcuts/shortcuts'
import { Button } from '../../shared/ui/Button'
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog'
import { IconButton } from '../../shared/ui/IconButton'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { InlineEditInput } from '../../shared/ui/InlineEditInput'
import { LoadingBar } from '../../shared/ui/LoadingBar'
import { MenuItem, MenuSeparator, OptionsMenu } from '../../shared/ui/Menu'
import { SegmentedControl } from '../../shared/ui/SegmentedControl'
import { Tooltip } from '../../shared/ui/Tooltip'
import { useToast } from '../../shared/ui/use-toast'
import { CloseIcon, ColumnsIcon, DocumentIcon, DownloadIcon, EllipsisIcon, EyeIcon, GearIcon, ImageIcon, LinkIcon, LockIcon, PencilIcon, RefreshIcon, SaveIcon, TrashIcon } from '../../shared/ui/icons'
import { MentionInChatMenuItem } from '../agent/MentionInChatMenuItem'
import { DocumentFormatBar } from './DocumentFormatBar'
import { FORMAT_SHORTCUTS } from './format-actions'
import { DocumentPreview } from './DocumentPreview'
import { setFrontMatter, type MetadataKey } from './document-dialect'
import { DocumentInspector, type EditorTask, type InspectorTab } from './DocumentInspector'
import { countWords, formatRelativeTime } from './document-format'
import { applyDocumentInsert, applyMarkdownFormat, imageReference, insertBlock, type DocumentInsert, type ImagePlacement, type MarkdownFormat, type TextEdit } from './markdown-format'
import type { DocumentActions, OpenDocument } from './use-documents'
import './documents.css'

type View = 'edit' | 'split' | 'preview'
const SAVE_COMBO = formatCombo({ ctrl: true, alt: false, shift: false, key: 'S' })

export function DocumentEditor({ document: doc, actions }: { document: OpenDocument; actions: DocumentActions }) {
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const { describeError } = actions
  const id = doc.saved.id
  const [error, setError] = useState<string | null>(null)
  const [task, setTask] = useState<EditorTask | null>(null)
  const [view, setView] = useState<View>('split')
  const [inspector, setInspector] = useState<InspectorTab | null>(null)
  const [menu, setMenu] = useState<'export' | 'more' | null>(null)
  const [confirm, setConfirm] = useState<'delete' | 'discard' | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const pendingSelection = useRef<[number, number] | null>(null)
  const busy = task !== null
  const locked = busy || doc.dirty

  const run = useCallback(async (next: EditorTask, work: () => Promise<unknown>) => {
    setError(null); setTask(next)
    try { await work(); return true } catch (e) {
      if (!(e instanceof Error && e.name === 'cancelled')) setError(describeError(e))
      return false
    } finally { setTask(null) }
  }, [describeError])
  const save = () => { if (!busy && doc.dirty) void run('save', () => actions.save(id)) }
  const exportAs = (format: 'md' | 'pdf') => {
    setMenu(null)
    void run('export', async () => {
      const result = await actions.exportFile(id, format)
      if (!(result && typeof result === 'object' && 'cancelled' in result)) showToast(t('documents.exported'))
    })
  }

  useEffect(() => {
    if (!doc.justCreated) return
    titleRef.current?.focus()
    titleRef.current?.select()
  }, [doc.justCreated])

  // Formatting replaces the text through `edit`; restore the selection once React rendered it.
  useLayoutEffect(() => {
    const selection = pendingSelection.current
    const textarea = textareaRef.current
    pendingSelection.current = null
    if (!selection || !textarea) return
    textarea.focus()
    textarea.setSelectionRange(selection[0], selection[1])
  }, [doc.markdown])
  const applyEdit = (edit: TextEdit) => {
    pendingSelection.current = [edit.selectionStart, edit.selectionEnd]
    actions.edit(id, { markdown: edit.text })
  }
  const format = (kind: MarkdownFormat) => {
    const textarea = textareaRef.current
    if (!textarea) return
    applyEdit(applyMarkdownFormat(doc.markdown, textarea.selectionStart, textarea.selectionEnd, kind, {
      text: t('documents.format.placeholder'), column: t('documents.format.column'), cell: t('documents.format.cell'),
    }))
  }
  const insert = (kind: DocumentInsert) => {
    const textarea = textareaRef.current
    if (!textarea) return
    applyEdit(applyDocumentInsert(doc.markdown, textarea.selectionStart, textarea.selectionEnd, kind, {
      title: t('documents.insert.titlePlaceholder'), text: t('documents.format.placeholder'), column: t('documents.insert.column'), caption: t('documents.insert.captionPlaceholder'),
    }))
  }
  const insertImage = (assetId: string, caption: string, placement: ImagePlacement) => {
    const textarea = textareaRef.current
    const end = textarea ? textarea.selectionEnd : doc.markdown.length
    applyEdit(insertBlock(doc.markdown, textarea ? textarea.selectionStart : end, end, imageReference(assetId, caption, placement)))
  }
  const changeMetadata = (patch: Partial<Record<MetadataKey, string | null>>) => actions.edit(id, { markdown: setFrontMatter(doc.markdown, patch) })
  const onEditorKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
      event.preventDefault(); event.stopPropagation(); save()
    }
  }
  const onTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
    const shortcut = FORMAT_SHORTCUTS[event.key.toLowerCase()]
    if (!shortcut) return
    event.preventDefault(); event.stopPropagation(); format(shortcut)
  }
  const toggleInspector = (tab: InspectorTab) => setInspector((current) => current === tab ? null : tab)
  const reportError = useCallback((message: string) => setError(message), [])

  const counted = useDeferredValue(doc.markdown)
  const words = useMemo(() => countWords(counted), [counted])
  const number = useMemo(() => new Intl.NumberFormat(language), [language])
  const status = task === 'save' ? 'saving' : doc.dirty ? 'unsaved' : 'saved'
  const lockedReason = doc.dirty ? t('documents.saveFirst') : undefined

  return <section className="document-editor" aria-label={t('documents.editor')} onKeyDown={onEditorKeyDown}>
    {(busy || actions.job) && <div className="document-progress"><LoadingBar /></div>}
    <header className="document-header">
      <DocumentIcon size={18} className="document-header-icon" />
      <div className="document-heading">
        <InlineEditInput ref={titleRef} className="document-title" aria-label={t('documents.title')} value={doc.title} maxLength={240}
          placeholder={t('documents.untitled')}
          onChange={(e) => actions.edit(id, { title: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save() } }} />
        <div className="document-meta">
          <span className={`document-status document-status--${status}`} role="status"><span className="document-status-dot" aria-hidden="true" />{t(`documents.${status}`)}</span>
          <span aria-hidden="true">·</span>
          <span>{t('documents.updatedAt', { time: formatRelativeTime(doc.saved.updatedAtMs, language) })}</span>
        </div>
      </div>
      <div className="document-actions">
        <Tooltip label={`${t('documents.save')} (${SAVE_COMBO})`}>
          <Button isLoading={task === 'save'} disabled={busy || !doc.dirty} onClick={save}>{task !== 'save' && <SaveIcon size={13} />}{t('documents.save')}</Button>
        </Tooltip>
        <OptionsMenu label={t('documents.export')} buttonClassName="ui-button ui-button--ghost ui-button--sm document-menu-button"
          icon={<><DownloadIcon size={13} /><span className="ui-button-label">{t('documents.exportShort')}</span></>}
          isOpen={menu === 'export'} onToggle={() => setMenu((open) => open === 'export' ? null : 'export')} onClose={() => setMenu(null)} menuPortal>
          {doc.dirty && <p className="document-menu-note">{t('documents.saveFirst')}</p>}
          <MenuItem icon={<DocumentIcon size={13} />} label={t('documents.exportMarkdown')} disabled={locked} onSelect={() => exportAs('md')} />
          <MenuItem icon={<DownloadIcon size={13} />} label={t('documents.exportPdf')} disabled={locked} onSelect={() => exportAs('pdf')} />
        </OptionsMenu>
        <OptionsMenu label={t('documents.moreActions')} icon={<EllipsisIcon size={14} />} isOpen={menu === 'more'}
          onToggle={() => setMenu((open) => open === 'more' ? null : 'more')} onClose={() => setMenu(null)} menuPortal>
          {doc.dirty
            ? <MenuItem icon={<RefreshIcon size={13} />} label={t('documents.discardChanges')} disabled={busy} onSelect={() => { setMenu(null); setConfirm('discard') }} />
            : <MenuItem icon={<RefreshIcon size={13} />} label={t('documents.reloadSaved')} disabled={busy} onSelect={() => { setMenu(null); void run('discard', () => actions.discard(id)) }} />}
          <MentionInChatMenuItem item={{ kind: 'document', id, label: doc.title }} onDone={() => setMenu(null)} />
          <MenuSeparator />
          <MenuItem icon={<TrashIcon size={13} />} label={t('documents.deleteDocument')} danger disabled={locked} onSelect={() => { setMenu(null); setConfirm('delete') }} />
        </OptionsMenu>
      </div>
    </header>
    <div className="document-toolbar">
      <DocumentFormatBar disabled={view === 'preview'} onFormat={format} onInsert={insert} />
      <div className="document-toolbar-end">
        <SegmentedControl<View> layout="inline" size="sm" ariaLabel={t('documents.view')} value={view} onChange={setView} options={[
          { value: 'edit', label: <span className="document-view-option" title={t('documents.edit')}><PencilIcon size={12} /><span className="document-view-label">{t('documents.edit')}</span></span> },
          { value: 'split', label: <span className="document-view-option" title={t('documents.split')}><ColumnsIcon size={12} /><span className="document-view-label">{t('documents.split')}</span></span> },
          { value: 'preview', label: <span className="document-view-option" title={t('documents.preview')}><EyeIcon size={12} /><span className="document-view-label">{t('documents.preview')}</span></span> },
        ]} />
        <span className="document-toolbar-separator" aria-hidden="true" />
        <Button variant="ghost" className="document-panel-toggle" title={t('documents.sources')} aria-pressed={inspector === 'sources'} onClick={() => toggleInspector('sources')}>
          <LinkIcon size={13} /><span className="document-panel-toggle-label">{t('documents.sources')}</span><span className="document-count">{doc.saved.sources.length}</span>
        </Button>
        <Button variant="ghost" className="document-panel-toggle" title={t('documents.imagesTab')} aria-pressed={inspector === 'images'} onClick={() => toggleInspector('images')}>
          <ImageIcon size={13} /><span className="document-panel-toggle-label">{t('documents.imagesTab')}</span><span className="document-count">{doc.saved.assets.length}</span>
        </Button>
        <Button variant="ghost" className="document-panel-toggle" title={t('documents.properties')} aria-pressed={inspector === 'properties'} onClick={() => toggleInspector('properties')}>
          <GearIcon size={13} /><span className="document-panel-toggle-label">{t('documents.properties')}</span>
        </Button>
      </div>
    </div>
    {error && <InlineAlert className="document-alert"><span>{error}</span><IconButton icon={<CloseIcon size={12} />} label={t('documents.dismiss')} onClick={() => setError(null)} /></InlineAlert>}
    <div className="document-body">
      <div className={`document-split document-split--${view}`}>
        {view !== 'preview' && <div className="document-code-pane">
          {view === 'split' && <div className="document-pane-heading">Markdown</div>}
          <textarea ref={textareaRef} aria-label={t('documents.markdown')} value={doc.markdown} spellCheck={false} placeholder={t('documents.markdownPlaceholder')}
            onChange={(e) => actions.edit(id, { markdown: e.target.value })} onKeyDown={onTextareaKeyDown} />
        </div>}
        {view !== 'edit' && <div className="document-preview-pane">
          {view === 'split' && <div className="document-pane-heading">{t('documents.preview')}</div>}
          <div className="document-preview" aria-label={t('documents.preview')}>
            <DocumentPreview title={doc.title} markdown={doc.markdown} rootPath={actions.rootPath} documentId={id} themes={actions.themes} />
          </div>
        </div>}
      </div>
      {inspector && <DocumentInspector document={doc} actions={actions} tab={inspector} busy={busy} onTabChange={setInspector} onClose={() => setInspector(null)}
        run={run} onError={reportError} onInsertImage={insertImage} themes={actions.themes} onMetadataChange={changeMetadata} />}
    </div>
    <footer className="document-statusbar">
      <span className="document-statusbar-item"><LockIcon size={11} />{t('documents.local')}</span>
      {actions.job && <span className="document-statusbar-item document-statusbar-job" role="status">{t('documents.working')}<Button variant="ghost" onClick={actions.cancelExport}>{t('documents.cancel')}</Button></span>}
      <span className="document-statusbar-spacer" />
      {lockedReason && <span className="document-statusbar-item document-statusbar-hint">{lockedReason}</span>}
      <span className="document-statusbar-item">{t(words === 1 ? 'documents.wordsOne' : 'documents.words', { count: number.format(words) })}</span>
      <span className="document-statusbar-item document-statusbar-optional">{t(doc.markdown.length === 1 ? 'documents.charactersOne' : 'documents.characters', { count: number.format(doc.markdown.length) })}</span>
      <span className="document-statusbar-item">{t('documents.revision', { revision: doc.saved.revision })}</span>
      <kbd className="document-statusbar-kbd document-statusbar-optional" title={t('documents.saveShortcut')}>{SAVE_COMBO}</kbd>
    </footer>
    {confirm === 'delete' && <ConfirmDialog title={t('documents.deleteDocument')} description={t('documents.deleteConfirm')} confirmLabel={t('documents.delete')} cancelLabel={t('documents.cancel')} closeAriaLabel={t('documents.cancel')}
      onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); void run('delete', () => actions.remove(id, doc.saved.revision)) }} />}
    {confirm === 'discard' && <ConfirmDialog title={t('documents.discardChanges')} description={t('documents.reloadConfirm')} confirmLabel={t('documents.discard')} cancelLabel={t('documents.cancel')} closeAriaLabel={t('documents.cancel')}
      onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); void run('discard', () => actions.discard(id)) }} />}
  </section>
}
