import { useState } from 'react'
import { t } from '../i18n'
import type { WebclientFolder } from '../types'

interface RequestTreeProps {
  root: WebclientFolder
  selectedId: string | null
  onSelect: (id: string) => void
}

export function RequestTree({ root, selectedId, onSelect }: RequestTreeProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const renderFolder = (folder: WebclientFolder, depth: number) => (
    <ul className="wc-tree__list" role={depth === 0 ? 'tree' : 'group'} aria-label={depth === 0 ? t('tree.label') : undefined}>
      {folder.folders.map((child) => {
        const open = !collapsed.has(child.id)
        return (
          <li key={child.id} role="treeitem" aria-expanded={open}>
            <button type="button" className="wc-tree__folder" onClick={() => toggle(child.id)}>
              <span className="wc-tree__chevron" aria-hidden="true">
                {open ? '▾' : '▸'}
              </span>
              {child.name}
            </button>
            {open && renderFolder(child, depth + 1)}
          </li>
        )
      })}
      {folder.requests.map((request) => (
        <li key={request.id} role="treeitem" aria-selected={request.id === selectedId}>
          <button
            type="button"
            className={`wc-tree__request${request.id === selectedId ? ' wc-tree__request--selected' : ''}`}
            onClick={() => onSelect(request.id)}
          >
            <span className={`wc-method wc-method--${request.protocol === 'graphql' ? 'graphql' : request.method.toLowerCase()}`}>
              {request.protocol === 'graphql' ? 'GQL' : request.method}
            </span>
            <span className="wc-tree__name">{request.name}</span>
          </button>
        </li>
      ))}
    </ul>
  )

  return (
    <nav className="wc-tree">
      <div className="wc-tree__root">{root.name}</div>
      {renderFolder(root, 0)}
    </nav>
  )
}
