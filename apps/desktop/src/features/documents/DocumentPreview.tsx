import { useId, useMemo, type CSSProperties, type ReactNode } from 'react'
import type { DocumentThemeSummary } from '../../bindings/documentation'
import { translate, type Language, type TranslationKey } from '../../shared/i18n/translations'
import { useLanguage } from '../../shared/i18n/use-language'
import { AlertIcon, CheckIcon, SparkleIcon } from '../../shared/ui/icons'
import { useMarkdownRenderer, type MarkdownImage } from '../notifications/use-markdown-renderer'
import '../notifications/markdown-view.css'
import { DocumentImage } from './DocumentImage'
import { parseDocument, type BlockAlign, type CalloutKind, type DocBlock, type DocumentDialect } from './document-dialect'

export const DEFAULT_DOCUMENT_ACCENT = '#2f5bd8'

interface DocumentPreviewProps {
  title: string
  markdown: string
  rootPath: string
  documentId: string
  /** Export themes; the preview takes the accent of the document's theme. */
  themes?: DocumentThemeSummary[]
}

const CALLOUT_LABELS: Record<CalloutKind, TranslationKey> = {
  note: 'documents.callout.note', tip: 'documents.callout.tip', warning: 'documents.callout.warning', danger: 'documents.callout.danger',
}

function CalloutIcon({ kind }: { kind: CalloutKind }) {
  if (kind === 'tip') return <CheckIcon size={14} />
  if (kind === 'note') return <SparkleIcon size={14} />
  return <AlertIcon size={14} />
}

/** The document as it exports: title or cover, contents, numbering, callouts, columns and figures. */
export function DocumentPreview({ title, markdown, rootPath, documentId, themes = [] }: DocumentPreviewProps) {
  const { language } = useLanguage()
  const dialect = useMemo(() => parseDocument(markdown), [markdown])
  const accent = (themes.find((theme) => theme.id === dialect.meta.theme) ?? themes[0])?.accent ?? DEFAULT_DOCUMENT_ACCENT
  const prefix = useId()
  // Labels follow the document's `lang`, like the export.
  const lang = dialect.meta.lang?.toLowerCase()
  const labelLanguage: Language = lang?.startsWith('pt') ? 'pt-BR' : lang?.startsWith('en') ? 'en' : language
  const label = (key: TranslationKey) => translate(labelLanguage, key)
  const anchor = (index: number) => `${prefix}-heading-${index}`

  const renderFigure = (assetId: string, caption: string, node: MarkdownImage, blockAlign: BlockAlign) => {
    const align = node.align ?? (blockAlign === 'left' ? 'center' : blockAlign)
    const number = dialect.figureNumbers.get(node)
    return <span className={`document-figure document-figure--${align}`}>
      <span className="document-figure-frame" style={node.width ? { width: `${Math.round(node.width * 100)}%` } : undefined}>
        <DocumentImage rootPath={rootPath} documentId={documentId} assetId={assetId} caption={caption} />
      </span>
      {caption && <span className="document-caption">{number !== undefined && <strong>{label('documents.preview.figure')} {number}: </strong>}{caption}</span>}
    </span>
  }

  return <article className="document-page markdown-view" style={{ '--document-accent': accent } as CSSProperties}>
    {dialect.meta.cover ? <Cover title={title} dialect={dialect} label={label} /> : <TitleBlock title={title} dialect={dialect} label={label} />}
    {dialect.meta.toc && !dialect.blocks.some((b) => b.type === 'toc') && dialect.outline.length > 0 && <Contents dialect={dialect} label={label} anchor={anchor} />}
    {!markdown.trim() || (dialect.blocks.length === 0 && !dialect.meta.cover)
      ? <p className="document-preview-empty">{label('documents.previewEmpty')}</p>
      : <Blocks blocks={dialect.blocks} dialect={dialect} label={label} anchor={anchor} renderFigure={renderFigure} />}
  </article>
}

type Label = (key: TranslationKey) => string

function metaRows(dialect: DocumentDialect, label: Label): [string, string][] {
  const { author, version, date, status } = dialect.meta
  return ([[label('documents.meta.author'), author], [label('documents.meta.version'), version], [label('documents.meta.date'), date], [label('documents.meta.status'), status]] as [string, string | undefined][])
    .filter((row): row is [string, string] => Boolean(row[1]))
}

function Cover({ title, dialect, label }: { title: string; dialect: DocumentDialect; label: Label }) {
  const rows = metaRows(dialect, label)
  return <header className="document-cover">
    <span className="document-cover-band" aria-hidden="true" />
    <h1 className="document-cover-title">{title}</h1>
    {dialect.meta.subtitle && <p className="document-cover-subtitle">{dialect.meta.subtitle}</p>}
    <span className="document-cover-rule" aria-hidden="true" />
    {rows.length > 0 && <dl className="document-cover-meta">{rows.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>}
    <PageBreak label={label} />
  </header>
}

function TitleBlock({ title, dialect, label }: { title: string; dialect: DocumentDialect; label: Label }) {
  const rows = metaRows(dialect, label)
  return <header className="document-title-block">
    <h1 className="document-doc-title">{title}</h1>
    {dialect.meta.subtitle && <p className="document-doc-subtitle">{dialect.meta.subtitle}</p>}
    {rows.length > 0 && <p className="document-doc-meta">{rows.map(([name, value]) => `${name}: ${value}`).join('   ·   ')}</p>}
    <span className="document-title-rule" aria-hidden="true" />
  </header>
}

function PageBreak({ label }: { label: Label }) {
  return <div className="document-pagebreak" role="separator" aria-label={label('documents.pageBreak')}><span>{label('documents.pageBreak')}</span></div>
}

function Contents({ dialect, label, anchor }: { dialect: DocumentDialect; label: Label; anchor: (index: number) => string }) {
  return <nav className="document-toc" aria-label={label('documents.preview.contents')}>
    <p className="document-toc-title">{label('documents.preview.contents')}</p>
    <ol>
      {dialect.outline.map((entry, index) => entry.level <= 3 && <li key={index} className={`document-toc-entry document-toc-entry--${entry.level}`}>
        <button type="button" onClick={() => document.getElementById(anchor(index))?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>
          {entry.number && <span className="document-toc-number">{entry.number}</span>}{entry.text}
        </button>
      </li>)}
    </ol>
  </nav>
}

interface BlocksProps {
  blocks: DocBlock[]
  dialect: DocumentDialect
  label: Label
  anchor: (index: number) => string
  renderFigure: (assetId: string, caption: string, node: MarkdownImage, align: BlockAlign) => ReactNode
}

function Blocks({ blocks, dialect, label, anchor, renderFigure }: BlocksProps) {
  return <>{blocks.map((block, index) => <BlockView key={index} block={block} dialect={dialect} label={label} anchor={anchor} renderFigure={renderFigure} />)}</>
}

function BlockView({ block, ...props }: Omit<BlocksProps, 'blocks'> & { block: DocBlock }) {
  const { dialect, label, anchor, renderFigure } = props
  const align = block.type === 'markdown' ? block.align : 'left'
  const { renderBlocks, renderInlines } = useMarkdownRenderer({ renderImage: (assetId, caption, node) => renderFigure(assetId, caption, node, align) })
  switch (block.type) {
    case 'pagebreak': return <PageBreak label={label} />
    case 'toc': return dialect.outline.length > 0 ? <Contents dialect={dialect} label={label} anchor={anchor} /> : null
    case 'columns':
      return <div className="document-columns" style={{ gridTemplateColumns: `repeat(${block.columns.length}, minmax(0, 1fr))` }}>
        {block.columns.map((column, index) => <div key={index} className="document-column"><Blocks blocks={column} {...props} /></div>)}
      </div>
    case 'callout':
      return <aside className={`document-callout document-callout--${block.kind}`}>
        <p className="document-callout-title"><CalloutIcon kind={block.kind} />{block.title ?? label(CALLOUT_LABELS[block.kind])}</p>
        <Blocks blocks={block.children} {...props} />
      </aside>
    case 'markdown': {
      const style = align !== 'left' ? { textAlign: align } : undefined
      const { block: md } = block
      if (md.type === 'heading') {
        const Heading = `h${Math.min(md.level, 6)}` as 'h1'
        const number = dialect.headingNumbers.get(md)
        const index = dialect.outline.findIndex((entry) => entry.block === md)
        return <Heading id={index >= 0 ? anchor(index) : undefined} style={style}>{number && <span className="document-heading-number">{number}</span>}{renderInlines(md.children)}</Heading>
      }
      if (md.type === 'table') {
        const number = dialect.tableNumbers.get(md)
        return <div className="document-table">
          {block.caption !== undefined && <p className="document-table-caption">{number !== undefined && <strong>{label('documents.preview.table')} {number}: </strong>}{block.caption}</p>}
          {renderBlocks([md])}
        </div>
      }
      return style ? <div style={style}>{renderBlocks([md])}</div> : <>{renderBlocks([md])}</>
    }
  }
}
