import { useState } from 'react'
import { ChevronDownIcon, ChevronRightIcon } from '../../shared/ui/icons'
import { childEntries, childrenOfRoot, isContainer, kindOf, summarize } from './output-tree'
import type { OutputEntry } from './output-tree'
import { useLanguage } from '../../shared/i18n/use-language'

interface OutputTreeProps {
  roots: OutputEntry[]
  selectedPath: string | null
  onSelect: (path: string | null) => void
}

/** Expandable output tree with bounded child pages; collapsed branches do not mount their descendants. */
export function OutputTree({ roots, selectedPath, onSelect }: OutputTreeProps) {
  return (
    <ul className="flow-output-tree" role="tree">
      {roots.map((root) => (
        <OutputRow
          key={root.key}
          entry={root}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
          initiallyOpen={root.key === 'body'}
          isRoot
        />
      ))}
    </ul>
  )
}

interface OutputRowProps {
  entry: OutputEntry
  depth: number
  selectedPath: string | null
  onSelect: (path: string | null) => void
  initiallyOpen?: boolean
  isRoot?: boolean
}

function OutputRow({ entry, depth, selectedPath, onSelect, initiallyOpen = false, isRoot = false }: OutputRowProps) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(initiallyOpen)
  const [offset, setOffset] = useState(0)
  const container = isContainer(entry.value)
  const kind = kindOf(entry.value)
  const selected = entry.path !== null && entry.path === selectedPath
  const summary = summarize(entry.value)

  const children = container && open ? (isRoot ? childrenOfRoot(entry) : childEntries(entry.value, entry.path)) : []

  return (
    <li role="treeitem" aria-expanded={container ? open : undefined} aria-selected={selected}>
      <button
        type="button"
        aria-label={`${entry.key} ${summary}`}
        className={`flow-output-row${selected ? ' flow-output-row--selected' : ''}`}
        style={{ paddingLeft: `calc(var(--space-2) + ${depth} * var(--space-4))` }}
        onClick={() => {
          if (container) setOpen((current) => !current)
          if (entry.path !== null) onSelect(entry.path)
        }}
        onKeyDown={(event) => {
          if (container && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) { event.preventDefault(); event.stopPropagation(); setOpen(event.key === 'ArrowRight') }
        }}
      >
        <span className="flow-output-chevron" aria-hidden="true">
          {container ? open ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} /> : null}
        </span>
        <span className="flow-output-key">{entry.key}</span>
        <span className={`flow-output-value flow-output-value--${kind}`} title={summary}>{summary}</span>
      </button>
      {children.length > 0 && (
        <ul role="group">
          {children.slice(offset, offset + 100).map((child) => (
            <OutputRow key={child.key} entry={child} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />
          ))}
          {children.length > 100 && <li role="none" className="flow-data-pagination"><button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>{t('flows.studio.previousPage')}</button><button type="button" disabled={offset + 100 >= children.length} onClick={() => setOffset(offset + 100)}>{t('flows.studio.nextPage')}</button></li>}
        </ul>
      )}
    </li>
  )
}
