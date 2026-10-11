import { useState } from 'react'
import { ChevronDownIcon, ChevronRightIcon } from '../../shared/ui/icons'
import { childEntries, childrenOfRoot, isContainer, kindOf, summarize } from './output-tree'
import type { OutputEntry } from './output-tree'

interface OutputTreeProps {
  roots: OutputEntry[]
  selectedPath: string | null
  onSelect: (path: string | null) => void
}

/** Árvore navegável do output de um node: expande objetos/arrays e permite
 * selecionar campo a campo. Os filhos só são montados quando o pai está
 * aberto, então um corpo grande não vira milhares de linhas de uma vez. */
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
  const [open, setOpen] = useState(initiallyOpen)
  const container = isContainer(entry.value)
  const kind = kindOf(entry.value)
  const selected = entry.path !== null && entry.path === selectedPath

  const children = container && open ? (isRoot ? childrenOfRoot(entry) : childEntries(entry.value, entry.path)) : []

  return (
    <li role="treeitem" aria-expanded={container ? open : undefined} aria-selected={selected}>
      <button
        type="button"
        className={`flow-output-row${selected ? ' flow-output-row--selected' : ''}`}
        style={{ paddingLeft: `calc(var(--space-2) + ${depth} * var(--space-4))` }}
        onClick={() => {
          if (container) setOpen((current) => !current)
          if (entry.path !== null) onSelect(entry.path)
        }}
      >
        <span className="flow-output-chevron" aria-hidden="true">
          {container ? open ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} /> : null}
        </span>
        <span className="flow-output-key">{entry.key}</span>
        <span className={`flow-output-value flow-output-value--${kind}`}>{summarize(entry.value)}</span>
      </button>
      {children.length > 0 && (
        <ul role="group">
          {children.map((child) => (
            <OutputRow key={child.key} entry={child} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  )
}
