import type { ReactNode } from 'react'
import type { TranslationKey } from '../../shared/i18n/translations'
import { BoldIcon, CodeIcon, DividerIcon, HeadingIcon, ItalicIcon, LinkIcon, ListIcon, ListOrderedIcon, QuoteIcon, StrikethroughIcon, TableIcon } from '../../shared/ui/icons'
import type { MarkdownFormat } from './markdown-format'

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
