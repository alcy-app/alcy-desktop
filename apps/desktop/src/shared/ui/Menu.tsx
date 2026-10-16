import { useLayoutEffect, useRef, type FocusEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon, EllipsisIcon } from './icons'
import { useTooltip } from './use-tooltip'
import './buttons.css'
import './menu.css'

interface OptionsMenuProps {
  label: string
  isOpen: boolean
  onToggle: () => void
  onClose: () => void
  children: ReactNode
  icon?: ReactNode
  /** Extra host class for feature-specific positioning and visibility. */
  wrapperClassName?: string
  buttonClassName?: string
  buttonDataState?: string
  menuClassName?: string
  /** Open above the trigger when there is more room there. */
  menuPlacement?: 'bottom' | 'auto'
  /** Ancestor selector defining the visible area for inline auto placement. */
  menuBoundarySelector?: string
  /** Render over the interface without contributing to an ancestor's scroll area. */
  menuPortal?: boolean
}

/** Icon button with an anchored menu that closes on blur or Escape. */
export function OptionsMenu({
  label,
  isOpen,
  onToggle,
  onClose,
  children,
  icon = <EllipsisIcon size={12} />,
  wrapperClassName,
  buttonClassName,
  buttonDataState,
  menuClassName,
  menuPlacement = 'bottom',
  menuBoundarySelector,
  menuPortal = false,
}: OptionsMenuProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!isOpen || !menuPortal) return
    const host = hostRef.current
    const menu = menuRef.current
    if (!host || !menu) return

    const margin = 8
    const gap = 2
    const rect = host.getBoundingClientRect()
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight
    menu.style.maxHeight = `${Math.max(0, viewportHeight - margin * 2)}px`
    menu.style.maxWidth = `${Math.max(0, viewportWidth - margin * 2)}px`
    const spaceBelow = viewportHeight - margin - rect.bottom - gap
    const spaceAbove = rect.top - margin - gap
    const above = menuPlacement === 'auto' && menu.offsetHeight > spaceBelow && spaceAbove > spaceBelow
    const top = above ? rect.top - gap - menu.offsetHeight : rect.bottom + gap
    menu.style.top = `${Math.max(margin, Math.min(top, viewportHeight - margin - menu.offsetHeight))}px`
    menu.style.left = `${Math.max(margin, Math.min(rect.right - menu.offsetWidth, viewportWidth - margin - menu.offsetWidth))}px`
    menu.classList.toggle('ui-menu--top', above)

    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!host.contains(target) && !menu.contains(target)) onClose()
    }
    const closeOnScroll = (event: Event) => {
      if (!menu.contains(event.target as Node | null)) onClose()
    }
    window.addEventListener('pointerdown', closeOutside)
    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', closeOnScroll, true)
    return () => {
      window.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', closeOnScroll, true)
    }
  }, [isOpen, menuPortal, menuPlacement, children, onClose])

  useLayoutEffect(() => {
    if (!isOpen || !menuPortal) return
    // Portal contents follow the app in DOM order, so move keyboard focus into the menu.
    const menu = menuRef.current
    const target = menu?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu
    target?.focus({ preventScroll: true })
  }, [isOpen, menuPortal])

  useLayoutEffect(() => {
    if (menuPortal) return
    if (!isOpen || menuPlacement !== 'auto') return

    const host = hostRef.current
    const menu = menuRef.current
    const boundary = menuBoundarySelector ? host?.closest<HTMLElement>(menuBoundarySelector) : null
    if (!host || !menu || !boundary) return

    const spaceBelow = boundary.getBoundingClientRect().bottom - host.getBoundingClientRect().bottom
    const spaceAbove = host.getBoundingClientRect().top - boundary.getBoundingClientRect().top
    menu.classList.toggle('ui-menu--top', menu.getBoundingClientRect().height > spaceBelow && spaceAbove > spaceBelow)
  }, [isOpen, menuBoundarySelector, menuPlacement, menuPortal])

  const closeOnBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!isOpen) return
    const next = event.relatedTarget as Node | null
    if (!hostRef.current?.contains(next) && !menuRef.current?.contains(next)) {
      onClose()
    }
  }

  // Hide the tooltip while it would cover the menu options.
  const { triggerProps, tooltip } = useTooltip(label, { enabled: !isOpen })
  const hostClassName = ['ui-menu-host', wrapperClassName, isOpen ? 'ui-menu-host--open' : null]
    .filter(Boolean)
    .join(' ')

  const menu = isOpen ? (
    <div
      ref={menuRef}
      className={['ui-menu', menuClassName, menuPortal ? 'ui-menu--portal' : null].filter(Boolean).join(' ')}
      role="menu"
      aria-label={label}
      // Clicking a non-interactive area keeps focus inside the menu.
      tabIndex={-1}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          onClose()
          hostRef.current?.querySelector('button')?.focus({ preventScroll: true })
        }
      }}
    >
      {children}
    </div>
  ) : null

  return (
    <div ref={hostRef} className={hostClassName} onBlur={closeOnBlur}>
      <button
        type="button"
        className={buttonClassName ?? 'ui-icon-button'}
        data-state={buttonDataState}
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-label={label}
        {...triggerProps}
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
      >
        {icon}
      </button>
      {tooltip}

      {menuPortal && menu ? createPortal(menu, document.body) : menu}
    </div>
  )
}

interface MenuItemProps {
  label: string
  danger?: boolean
  disabled?: boolean
  autoFocus?: boolean
  /** Mark the selected option in a single-selection menu. */
  selected?: boolean
  onSelect: () => void
}

export function MenuItem({ label, danger, disabled, autoFocus, selected, onSelect }: MenuItemProps) {
  return (
    <button
      type="button"
      role={selected === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={selected}
      className={[
        'ui-menu-item',
        danger ? 'ui-menu-item--danger' : null,
        selected ? 'ui-menu-item--selected' : null,
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={disabled}
      autoFocus={autoFocus}
      onClick={onSelect}
    >
      {label}
    </button>
  )
}

interface MenuCheckboxItemProps {
  label: string
  checked: boolean
  /** Marker before the text, such as a label color. */
  leading?: ReactNode
  autoFocus?: boolean
  onToggle: () => void
}

/** Toggle a filter without closing the menu. */
export function MenuCheckboxItem({ label, checked, leading, autoFocus, onToggle }: MenuCheckboxItemProps) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      className="ui-menu-item ui-menu-item--checkbox"
      autoFocus={autoFocus}
      onClick={onToggle}
    >
      <span className="ui-menu-item-check" aria-hidden="true">
        {checked && <CheckIcon size={11} />}
      </span>
      {leading}
      <span className="ui-menu-item-label">{label}</span>
    </button>
  )
}

/** Separator between groups of options. */
export function MenuSeparator() {
  return <div className="ui-menu-separator" role="separator" />
}
