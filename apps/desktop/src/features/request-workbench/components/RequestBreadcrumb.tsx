import { useRef, useState, type ReactNode } from 'react'
import { useLanguage } from '../../../shared/i18n/use-language'
import { BranchIcon, ChevronRightIcon, GlobeIcon } from '../../../shared/ui/icons'
import type { WorkbenchProtocol } from '../request-workbench.types'

interface RequestBreadcrumbProps {
  segments: string[]
  protocol: WorkbenchProtocol
  /** Actions aligned to the right of the row (e.g. share), above the Send button. */
  actions?: ReactNode
  /** Renames the request shown in the last segment; without it the name is read-only. */
  onRename?: (name: string) => void
}

export function RequestBreadcrumb({ segments, protocol, actions, onRename }: RequestBreadcrumbProps) {
  const { t } = useLanguage()

  return (
    <div className="rw-request-breadcrumb">
      <nav className="rw-request-breadcrumb-nav" aria-label={t('workbench.breadcrumb.ariaLabel')}>
        <span className={`rw-request-breadcrumb-icon rw-request-breadcrumb-icon--${protocol}`} aria-hidden="true">
          {protocol === 'graphql' ? <BranchIcon size={12} /> : <GlobeIcon size={12} />}
        </span>
        <ol className="rw-request-breadcrumb-list">
          {segments.map((segment, index) => {
            const current = index === segments.length - 1
            return (
              <li
                key={`${index}:${segment}`}
                className={`rw-request-breadcrumb-item${current ? ' rw-request-breadcrumb-item--current' : ''}`}
              >
                {index > 0 && <ChevronRightIcon size={9} className="rw-request-breadcrumb-separator" />}
                {current && onRename ? (
                  <RenamableSegment name={segment} onRename={onRename} />
                ) : (
                  <span className="rw-request-breadcrumb-label" aria-current={current ? 'page' : undefined} title={segment}>
                    {segment}
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      </nav>
      {actions && <div className="rw-request-breadcrumb-actions">{actions}</div>}
    </div>
  )
}

/** Request name that turns into a field on click: Enter or leaving the field saves, Escape cancels. */
function RenamableSegment({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const { t } = useLanguage()
  const [draft, setDraft] = useState<string | null>(null)
  // Escape unmounts the field; the guard keeps a late blur from saving the discarded draft.
  const finishedRef = useRef(false)

  const start = () => {
    finishedRef.current = false
    setDraft(name)
  }

  const finish = (save: boolean) => {
    if (finishedRef.current || draft === null) return
    finishedRef.current = true
    const trimmed = draft.trim()
    if (save && trimmed && trimmed !== name) onRename(trimmed)
    setDraft(null)
  }

  if (draft === null) {
    return (
      <button
        type="button"
        className="rw-request-breadcrumb-label rw-request-breadcrumb-rename"
        aria-current="page"
        aria-label={t('workbench.breadcrumb.renameAria', { name })}
        title={t('workbench.breadcrumb.renameAria', { name })}
        onClick={start}
      >
        {name}
      </button>
    )
  }

  return (
    // The hidden mirror sizes the grid cell to the typed text, so the field grows with the name.
    <span className="rw-request-breadcrumb-edit">
      <span className="rw-request-breadcrumb-edit-mirror" aria-hidden="true">{draft || ' '}</span>
      <input
        className="rw-request-breadcrumb-label rw-request-breadcrumb-input"
        value={draft}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        aria-label={t('common.name')}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            finish(true)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            finish(false)
          }
        }}
      />
    </span>
  )
}
