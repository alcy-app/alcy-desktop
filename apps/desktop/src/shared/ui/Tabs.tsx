import { useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import './tabs.css'

interface TabDefinition<T extends string> {
  id: T
  label: ReactNode
  disabled?: boolean
  /** Count beside the label, omitted when absent or zero. */
  badge?: number
}

interface TabsProps<T extends string> {
  tabs: Array<TabDefinition<T>>
  activeTab: T
  onChange: (id: T) => void
  ariaLabel: string
  idPrefix?: string
  /** Compact spacing and typography for sidebar tabs. */
  variant?: 'default' | 'compact'
  className?: string
}

/** Tab list with Arrow/Home/End navigation; consumers render the panels. */
export function Tabs<T extends string>({
  tabs,
  activeTab,
  onChange,
  ariaLabel,
  idPrefix = '',
  variant = 'default',
  className,
}: TabsProps<T>) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const focusTab = (index: number) => {
    const wrapped = (index + tabs.length) % tabs.length
    tabRefs.current[wrapped]?.focus()
    onChange(tabs[wrapped].id)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault()
        focusTab(index + 1)
        break
      case 'ArrowLeft':
        event.preventDefault()
        focusTab(index - 1)
        break
      case 'Home':
        event.preventDefault()
        focusTab(0)
        break
      case 'End':
        event.preventDefault()
        focusTab(tabs.length - 1)
        break
      default:
        break
    }
  }

  const listClass = ['ui-tabs', variant === 'compact' ? 'ui-tabs--compact' : null, className].filter(Boolean).join(' ')

  return (
    <div className={listClass} role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTab
        return (
          <button
            key={tab.id}
            ref={(element) => {
              tabRefs.current[index] = element
            }}
            type="button"
            role="tab"
            id={`tab-${idPrefix}${tab.id}`}
            aria-selected={isActive}
            aria-controls={`tabpanel-${idPrefix}${tab.id}`}
            aria-disabled={tab.disabled || undefined}
            disabled={tab.disabled}
            tabIndex={isActive ? 0 : -1}
            className="ui-tab"
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {tab.label}
            {tab.badge != null && tab.badge > 0 && (
              <span className="ui-tab-badge" aria-hidden="true">
                <span className="ui-tab-badge-label">{tab.badge}</span>
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
