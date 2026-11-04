import { useEffect, useState } from 'react'
import { documentCall, type DocumentSource, type DocumentSourceList, type DocumentThemeSummary } from '../../bindings/documentation'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Checkbox } from '../../shared/ui/Checkbox'
import { Field } from '../../shared/ui/Field'
import { IconButton } from '../../shared/ui/IconButton'
import { Input } from '../../shared/ui/Input'
import { SegmentedControl } from '../../shared/ui/SegmentedControl'
import { Select } from '../../shared/ui/Select'
import { Tooltip } from '../../shared/ui/Tooltip'
import { AlertIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, ImageIcon, ImportIcon, PlusIcon, RobotIcon, SearchIcon, SendIcon } from '../../shared/ui/icons'
import { DocumentImage } from './DocumentImage'
import { formatDateTime } from './document-format'
import { parseMeta, splitFrontMatter, type MetadataKey } from './document-dialect'
import type { ImagePlacement } from './markdown-format'
import type { DocumentActions, OpenDocument } from './use-documents'

export type InspectorTab = 'sources' | 'images' | 'properties'
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
  onInsertImage: (assetId: string, caption: string, placement: ImagePlacement) => void
  themes: DocumentThemeSummary[]
  onMetadataChange: (patch: Partial<Record<MetadataKey, string | null>>) => void
}

const PAGE = 25
const sameSource = (a: DocumentSource, b: DocumentSource) => a.id === b.id && a.kind === b.kind

function SourceKindIcon({ kind }: { kind: DocumentSource['kind'] }) {
  return <span className={`document-source-icon document-source-icon--${kind}`} aria-hidden="true">{kind === 'chat' ? <RobotIcon size={13} /> : <SendIcon size={13} />}</span>
}

/** Side panel with the evidence a document draws on: selected sources and attached images. */
export function DocumentInspector({ document: doc, actions, tab, busy, onTabChange, onClose, run, onError, onInsertImage, themes, onMetadataChange }: DocumentInspectorProps) {
  const { t } = useLanguage()
  return <aside className="document-inspector" aria-label={t('documents.inspector.label')}>
    <header className="document-inspector-header">
      <SegmentedControl<InspectorTab> layout="inline" size="sm" ariaLabel={t('documents.inspector.label')} value={tab} onChange={onTabChange} options={[
        { value: 'sources', label: t('documents.sources'), trailing: <span className="document-count">{doc.saved.sources.length}</span> },
        { value: 'images', label: t('documents.imagesTab'), trailing: <span className="document-count">{doc.saved.assets.length}</span> },
        { value: 'properties', label: t('documents.properties') },
      ]} />
      <IconButton icon={<CloseIcon size={13} />} label={t('documents.inspector.close')} onClick={onClose} />
    </header>
    {doc.dirty && tab !== 'properties' && <p className="document-inspector-locked" role="note"><AlertIcon size={13} />{t('documents.inspector.locked')}</p>}
    <div className="document-inspector-body">
      {tab === 'sources' && <SourcesSection document={doc} actions={actions} busy={busy} run={run} onError={onError} />}
      {tab === 'images' && <ImagesSection document={doc} actions={actions} busy={busy} run={run} onInsertImage={onInsertImage} />}
      {tab === 'properties' && <PropertiesSection markdown={doc.markdown} themes={themes} onChange={onMetadataChange} />}
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
  const [width, setWidth] = useState('')
  const [align, setAlign] = useState<'left' | 'center' | 'right'>('center')
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
      {doc.saved.assets.length > 0 && <div className="document-placement">
        <Field label={t('documents.imageWidth')}>
          {(id) => <Select id={id} value={width} onChange={(e) => setWidth(e.target.value)}>
            <option value="">{t('documents.imageWidthAuto')}</option>
            {[25, 50, 75, 100].map((percent) => <option key={percent} value={percent}>{percent}%</option>)}
          </Select>}
        </Field>
        <div className="document-placement-align">
          <span className="document-inspector-subheading">{t('documents.imageAlign')}</span>
          <SegmentedControl<'left' | 'center' | 'right'> layout="inline" size="sm" ariaLabel={t('documents.imageAlign')} value={align} onChange={setAlign} options={[
            { value: 'left', label: t('documents.alignLeft') }, { value: 'center', label: t('documents.alignCenter') }, { value: 'right', label: t('documents.alignRight') },
          ]} />
        </div>
      </div>}
      {doc.saved.assets.length === 0
        ? <p className="document-inspector-empty"><ImageIcon size={13} />{t('documents.noImages')}</p>
        : <ul className="document-asset-list">{doc.saved.assets.map((asset) => <li key={asset.id} className="document-asset">
          <DocumentImage variant="thumbnail" rootPath={actions.rootPath} documentId={doc.saved.id} assetId={asset.id} caption={asset.caption} />
          <span className="document-asset-caption" title={asset.caption}>{asset.caption}</span>
          <IconButton icon={<PlusIcon size={13} />} label={t('documents.insertImage', { caption: asset.caption })} onClick={() => onInsertImage(asset.id, asset.caption, { width: width ? Number(width) : undefined, align: align === 'center' ? undefined : align })} />
        </li>)}</ul>}
    </section>
  </>
}

/** Keeps what the user types (spaces included) while the metadata stores the trimmed value. */
function MetadataInput({ id, value, placeholder, onCommit }: { id: string; value?: string; placeholder?: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value ?? '')
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    if ((value ?? '') !== draft.trim()) setDraft(value ?? '')
  }
  return <Input id={id} value={draft} maxLength={200} placeholder={placeholder} onChange={(e) => { setDraft(e.target.value); onCommit(e.target.value) }} />
}

function PropertiesSection({ markdown, themes, onChange }: { markdown: string; themes: DocumentThemeSummary[]; onChange: DocumentInspectorProps['onMetadataChange'] }) {
  const { t } = useLanguage()
  const meta = parseMeta(splitFrontMatter(markdown)?.pairs ?? [])
  const text = (key: 'subtitle' | 'author' | 'version' | 'date' | 'status', label: string, placeholder?: string) => <Field label={label}>
    {(id) => <MetadataInput id={id} value={meta[key]} placeholder={placeholder} onCommit={(value) => onChange({ [key]: value || null })} />}
  </Field>
  const toggle = (key: 'cover' | 'toc' | 'numbering', label: string, hint: string) => <label className="document-toggle">
    <Checkbox checked={meta[key]} onChange={(e) => onChange({ [key]: e.target.checked ? 'true' : null })} />
    <span><span className="document-toggle-label">{label}</span><span className="document-toggle-hint">{hint}</span></span>
  </label>
  return <>
    <p className="document-inspector-help">{t('documents.propertiesHelp')}</p>
    <section className="document-inspector-section" aria-label={t('documents.propertiesCover')}>
      <h3 className="document-inspector-heading">{t('documents.propertiesCover')}</h3>
      {text('subtitle', t('documents.meta.subtitle'), t('documents.meta.subtitlePlaceholder'))}
      {text('author', t('documents.meta.author'))}
      <div className="document-field-row">
        {text('version', t('documents.meta.version'), '1.0')}
        {text('date', t('documents.meta.date'), new Date().toISOString().slice(0, 10))}
      </div>
      {text('status', t('documents.meta.status'), t('documents.meta.statusPlaceholder'))}
    </section>
    <section className="document-inspector-section" aria-label={t('documents.propertiesLayout')}>
      <h3 className="document-inspector-heading">{t('documents.propertiesLayout')}</h3>
      {toggle('cover', t('documents.meta.cover'), t('documents.meta.coverHint'))}
      {toggle('toc', t('documents.meta.toc'), t('documents.meta.tocHint'))}
      {toggle('numbering', t('documents.meta.numbering'), t('documents.meta.numberingHint'))}
    </section>
    <section className="document-inspector-section" aria-label={t('documents.propertiesExport')}>
      <h3 className="document-inspector-heading">{t('documents.propertiesExport')}</h3>
      {themes.length > 1 && <Field label={t('documents.meta.theme')}>
        {(id) => <Select id={id} value={themes.some((theme) => theme.id === meta.theme) ? meta.theme : themes[0].id} onChange={(e) => onChange({ theme: e.target.value === themes[0].id ? null : e.target.value })}>
          {themes.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
        </Select>}
      </Field>}
      <Field label={t('documents.meta.lang')} hint={t('documents.meta.langHint')}>
        {(id) => <Select id={id} value={meta.lang ?? ''} onChange={(e) => onChange({ lang: e.target.value || null })}>
          <option value="">{t('documents.meta.langAuto')}</option>
          <option value="pt-BR">Português (Brasil)</option>
          <option value="en">English</option>
        </Select>}
      </Field>
    </section>
  </>
}
