import { useEffect, useState } from 'react'
import { documentCall, type DocumentSource, type DocumentSourceList } from '../../bindings/documentation'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Checkbox } from '../../shared/ui/Checkbox'
import { Field } from '../../shared/ui/Field'
import { IconButton } from '../../shared/ui/IconButton'
import { Input } from '../../shared/ui/Input'
import { SegmentedControl } from '../../shared/ui/SegmentedControl'
import { Tooltip } from '../../shared/ui/Tooltip'
import { AlertIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, ImageIcon, ImportIcon, PlusIcon, RobotIcon, SearchIcon, SendIcon } from '../../shared/ui/icons'
import { DocumentImage } from './DocumentImage'
import { formatDateTime } from './document-format'
import type { DocumentActions, OpenDocument } from './use-documents'

export type InspectorTab = 'sources' | 'images'
export type EditorTask = 'save' | 'export' | 'sources' | 'image' | 'discard' | 'delete'

interface DocumentInspectorProps {
  document: OpenDocument
  actions: DocumentActions
  tab: InspectorTab
  busy: boolean
  onTabChange: (tab: InspectorTab) => void
  onClose: () => void
  run: (task: EditorTask, work: () => Promise<unknown>) => Promise<boolean>
  onError: (message: string) => void
  onInsertImage: (assetId: string, caption: string) => void
}

const PAGE = 25
const sameSource = (a: DocumentSource, b: DocumentSource) => a.id === b.id && a.kind === b.kind

function SourceKindIcon({ kind }: { kind: DocumentSource['kind'] }) {
  return <span className={`document-source-icon document-source-icon--${kind}`} aria-hidden="true">{kind === 'chat' ? <RobotIcon size={13} /> : <SendIcon size={13} />}</span>
}

/** Side panel with the evidence a document draws on: selected sources and attached images. */
export function DocumentInspector({ document: doc, actions, tab, busy, onTabChange, onClose, run, onError, onInsertImage }: DocumentInspectorProps) {
  const { t } = useLanguage()
  return <aside className="document-inspector" aria-label={t('documents.inspector.label')}>
    <header className="document-inspector-header">
      <SegmentedControl<InspectorTab> layout="inline" size="sm" ariaLabel={t('documents.inspector.label')} value={tab} onChange={onTabChange} options={[
        { value: 'sources', label: t('documents.sources'), trailing: <span className="document-count">{doc.saved.sources.length}</span> },
        { value: 'images', label: t('documents.imagesTab'), trailing: <span className="document-count">{doc.saved.assets.length}</span> },
      ]} />
      <IconButton icon={<CloseIcon size={13} />} label={t('documents.inspector.close')} onClick={onClose} />
    </header>
    {doc.dirty && <p className="document-inspector-locked" role="note"><AlertIcon size={13} />{t('documents.inspector.locked')}</p>}
    <div className="document-inspector-body">
      {tab === 'sources'
        ? <SourcesSection document={doc} actions={actions} busy={busy} run={run} onError={onError} />
        : <ImagesSection document={doc} actions={actions} busy={busy} run={run} onInsertImage={onInsertImage} />}
    </div>
  </aside>
}

function SourceRow({ source, checked, disabled, onToggle }: { source: DocumentSource; checked: boolean; disabled: boolean; onToggle: () => void }) {
  const { t, language } = useLanguage()
  return <label className="document-source-row">
    <Checkbox checked={checked} disabled={disabled} onChange={onToggle} />
    <SourceKindIcon kind={source.kind} />
    <span className="document-source-text">
      <span className="document-source-label" title={source.label}>{source.label}</span>
      <span className="document-source-meta">{t(source.kind === 'chat' ? 'documents.conversation' : 'documents.request')}{source.atMs ? ` · ${formatDateTime(source.atMs, language)}` : ''}</span>
    </span>
  </label>
}

function SourcesSection({ document: doc, actions, busy, run, onError }: Pick<DocumentInspectorProps, 'document' | 'actions' | 'busy' | 'run' | 'onError'>) {
  const { t } = useLanguage()
  const { rootPath, describeError } = actions
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [choices, setChoices] = useState<DocumentSourceList | null>(null)
  const locked = busy || doc.dirty
  useEffect(() => {
    let cancelled = false
    void documentCall<DocumentSourceList>(rootPath, 'sources', { query, offset }).then((value) => { if (!cancelled) setChoices(value) }).catch((e: unknown) => { if (!cancelled) onError(describeError(e)) })
    return () => { cancelled = true }
  }, [query, offset, rootPath, describeError, onError])
  const selected = doc.saved.sources
  const toggle = (source: DocumentSource) => {
    const next = selected.some((s) => sameSource(s, source)) ? selected.filter((s) => !sameSource(s, source)) : [...selected, source]
    void run('sources', () => actions.selectSources(doc.saved.id, doc.saved.revision, next))
  }
  return <>
    <p className="document-inspector-help">{t('documents.sourcesHelp')}</p>
    <section className="document-inspector-section" aria-label={t('documents.selectedSources')}>
      <h3 className="document-inspector-heading">{t('documents.selectedSources')}</h3>
      {selected.length === 0
        ? <p className="document-inspector-empty">{t('documents.noSources')}</p>
        : selected.map((source) => <div key={`selected:${source.kind}:${source.id}`} className="document-source-chip">
          <SourceKindIcon kind={source.kind} />
          <span className="document-source-label" title={source.label}>{source.label}</span>
          <IconButton icon={<CloseIcon size={11} />} label={t('documents.removeSource', { name: source.label })} disabled={locked} onClick={() => toggle(source)} />
        </div>)}
    </section>
    <section className="document-inspector-section" aria-label={t('documents.availableSources')}>
      <h3 className="document-inspector-heading">{t('documents.availableSources')}</h3>
      <div className="document-search">
        <SearchIcon size={12} className="document-search-icon" />
        <Input className="document-search-input" aria-label={t('documents.searchSources')} placeholder={t('documents.searchSources')} value={query}
          onChange={(e) => { setQuery(e.target.value); setOffset(0) }}
          onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); setOffset(0) } }} />
      </div>
      {choices === null
        ? <p className="document-inspector-empty" role="status">{t('documents.loading')}</p>
        : choices.sources.length === 0
          ? <p className="document-inspector-empty">{t(query ? 'documents.noSourceMatches' : 'documents.noAvailableSources')}</p>
          : <div className="document-source-list">{choices.sources.map((source) => <SourceRow key={`${source.kind}:${source.id}`} source={source} checked={selected.some((s) => sameSource(s, source))} disabled={locked} onToggle={() => toggle(source)} />)}</div>}
      {(offset > 0 || choices?.nextOffset != null) && <div className="document-inspector-pager">
        <IconButton icon={<ChevronLeftIcon size={13} />} label={t('documents.previous')} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} />
        <span>{t('documents.page', { page: Math.floor(offset / PAGE) + 1 })}</span>
        <IconButton icon={<ChevronRightIcon size={13} />} label={t('documents.next')} disabled={choices?.nextOffset == null} onClick={() => setOffset(choices?.nextOffset ?? 0)} />
      </div>}
    </section>
  </>
}

function ImagesSection({ document: doc, actions, busy, run, onInsertImage }: Pick<DocumentInspectorProps, 'document' | 'actions' | 'busy' | 'run' | 'onInsertImage'>) {
  const { t } = useLanguage()
  const [caption, setCaption] = useState('')
  const locked = busy || doc.dirty
  const ready = !locked && caption.trim() !== ''
  const requests = doc.saved.sources.filter((s) => s.kind === 'request')
  const attach = async (work: () => Promise<unknown>) => { if (await run('image', work)) setCaption('') }
  return <>
    <section className="document-inspector-section" aria-label={t('documents.addImage')}>
      <h3 className="document-inspector-heading">{t('documents.addImage')}</h3>
      <Field label={t('documents.caption')} hint={t('documents.captionHint')}>
        {(id) => <Input id={id} value={caption} maxLength={500} placeholder={t('documents.captionPlaceholder')} onChange={(e) => setCaption(e.target.value)} />}
      </Field>
      <Button variant="ghost" className="document-inspector-action" disabled={!ready} onClick={() => void attach(() => actions.importImage(doc.saved.id, doc.saved.revision, caption))}>
        <ImportIcon size={13} />{t('documents.attachImage')}
      </Button>
      {requests.length > 0 && <div className="document-capture">
        <span className="document-inspector-subheading">{t('documents.captureFrom')}</span>
        {requests.map((source) => <Tooltip key={source.id} label={source.label} className="document-capture-host">
          <Button variant="ghost" className="document-inspector-action" disabled={!ready} onClick={() => void attach(() => actions.captureImage(doc.saved.id, doc.saved.revision, caption, { sourceId: source.id }))}>
            <SendIcon size={13} /><span className="document-capture-label">{source.label}</span>
          </Button>
        </Tooltip>)}
      </div>}
    </section>
    <section className="document-inspector-section" aria-label={t('documents.attachedImages')}>
      <h3 className="document-inspector-heading">{t('documents.attachedImages')}</h3>
      {doc.saved.assets.length === 0
        ? <p className="document-inspector-empty"><ImageIcon size={13} />{t('documents.noImages')}</p>
        : <ul className="document-asset-list">{doc.saved.assets.map((asset) => <li key={asset.id} className="document-asset">
          <DocumentImage variant="thumbnail" rootPath={actions.rootPath} documentId={doc.saved.id} assetId={asset.id} caption={asset.caption} />
          <span className="document-asset-caption" title={asset.caption}>{asset.caption}</span>
          <IconButton icon={<PlusIcon size={13} />} label={t('documents.insertImage', { caption: asset.caption })} onClick={() => onInsertImage(asset.id, asset.caption)} />
        </li>)}</ul>}
    </section>
  </>
}
