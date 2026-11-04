import type { ReactNode } from 'react'
import type { TranslationKey } from '../../shared/i18n/translations'
import { AlertIcon, BoldIcon, CheckIcon, CodeIcon, ColumnsIcon, DividerIcon, DocumentIcon, HeadingIcon, ItalicIcon, LinkIcon, ListIcon, ListOrderedIcon, QuoteIcon, SparkleIcon, StrikethroughIcon, TableIcon } from '../../shared/ui/icons'
import type { DocumentInsert, MarkdownFormat } from './markdown-format'

export interface FormatAction { format: MarkdownFormat; label: TranslationKey; icon: ReactNode; shortcut?: string }

export const FORMAT_GROUPS: FormatAction[][] = [
  [{ format: 'heading', label: 'documents.format.heading', icon: <HeadingIcon size={14} /> }],
  [
    { format: 'bold', label: 'documents.format.bold', icon: <BoldIcon size={14} />, shortcut: 'B' },
    { format: 'italic', label: 'documents.format.italic', icon: <ItalicIcon size={14} />, shortcut: 'I' },
    { format: 'strike', label: 'documents.format.strike', icon: <StrikethroughIcon size={14} /> },
    { format: 'code', label: 'documents.format.code', icon: <CodeIcon size={14} /> },
    { format: 'link', label: 'documents.format.link', icon: <LinkIcon size={14} />, shortcut: 'K' },
  ],
  [
    { format: 'bullet', label: 'documents.format.bullet', icon: <ListIcon size={14} /> },
    { format: 'ordered', label: 'documents.format.ordered', icon: <ListOrderedIcon size={14} /> },
    { format: 'quote', label: 'documents.format.quote', icon: <QuoteIcon size={14} /> },
  ],
  [
    { format: 'table', label: 'documents.format.table', icon: <TableIcon size={14} /> },
    { format: 'rule', label: 'documents.format.rule', icon: <DividerIcon size={14} /> },
  ],
]

/** Formats the editor applies for Ctrl/⌘ + letter inside the textarea, keyed by lowercase letter. */
export const FORMAT_SHORTCUTS: Readonly<Record<string, MarkdownFormat>> = Object.fromEntries(
  FORMAT_GROUPS.flat().flatMap((action) => action.shortcut ? [[action.shortcut.toLowerCase(), action.format]] : []),
)

export interface InsertAction { insert: DocumentInsert; label: TranslationKey; icon: ReactNode }

/** The "Insert" menu: dialect blocks grouped by purpose. */
export const INSERT_GROUPS: InsertAction[][] = [
  [
    { insert: 'note', label: 'documents.insert.note', icon: <SparkleIcon size={13} /> },
    { insert: 'tip', label: 'documents.insert.tip', icon: <CheckIcon size={13} /> },
    { insert: 'warning', label: 'documents.insert.warning', icon: <AlertIcon size={13} /> },
    { insert: 'danger', label: 'documents.insert.danger', icon: <AlertIcon size={13} /> },
  ],
  [
    { insert: 'columns2', label: 'documents.insert.columns2', icon: <ColumnsIcon size={13} /> },
    { insert: 'columns3', label: 'documents.insert.columns3', icon: <ColumnsIcon size={13} /> },
    { insert: 'center', label: 'documents.insert.center', icon: <DividerIcon size={13} /> },
  ],
  [
    { insert: 'tableCaption', label: 'documents.insert.tableCaption', icon: <TableIcon size={13} /> },
    { insert: 'toc', label: 'documents.insert.toc', icon: <ListOrderedIcon size={13} /> },
    { insert: 'pagebreak', label: 'documents.insert.pagebreak', icon: <DocumentIcon size={13} /> },
  ],
]
