import { useLayoutEffect, useRef, type FocusEvent, type ReactNode } from 'react'
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
  /** Classe extra no host, para posicionamento/reveal específicos da feature. */
  wrapperClassName?: string
  buttonClassName?: string
  buttonDataState?: string
  menuClassName?: string
  /** Abre acima do gatilho quando o menu não cabe abaixo do limite informado. */
  menuPlacement?: 'bottom' | 'auto'
  /** Seletor do ancestral que delimita a área visível para `menuPlacement="auto"`. */
  menuBoundarySelector?: string
}

/** Botão-ícone que abre um menu ancorado (`role="menu"`), fechando por blur ou Escape. */
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
}: OptionsMenuProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // A posição absoluta participa da área rolável do ancestral. Quando não há
  // espaço abaixo, abrir para cima mantém o menu dentro do painel rolável sem
  // fazê-lo crescer só para acomodar as opções.
  useLayoutEffect(() => {
    if (!isOpen || menuPlacement !== 'auto') return

    const host = hostRef.current
    const menu = menuRef.current
    const boundary = menuBoundarySelector ? host?.closest<HTMLElement>(menuBoundarySelector) : null
    if (!host || !menu || !boundary) return

    const spaceBelow = boundary.getBoundingClientRect().bottom - host.getBoundingClientRect().bottom
    const spaceAbove = host.getBoundingClientRect().top - boundary.getBoundingClientRect().top
    menu.classList.toggle('ui-menu--top', menu.getBoundingClientRect().height > spaceBelow && spaceAbove > spaceBelow)
  }, [isOpen, menuBoundarySelector, menuPlacement])

  const closeOnBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      onClose()
    }
  }

  // Com o menu aberto, o tooltip cobriria as opções.
  const { triggerProps, tooltip } = useTooltip(label, { enabled: !isOpen })
  const hostClassName = ['ui-menu-host', wrapperClassName, isOpen ? 'ui-menu-host--open' : null]
    .filter(Boolean)
    .join(' ')

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

      {isOpen && (
        <div
          ref={menuRef}
          className={['ui-menu', menuClassName].filter(Boolean).join(' ')}
          role="menu"
          aria-label={label}
          // Focável só pelo clique: um clique numa área sem foco próprio
          // (título, espaçamento, texto) leva o foco ao menu em vez do
          // <body>, e o blur do host não o confunde com um clique fora.
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose()
          }}
        >
          {children}
        </div>
      )}
    </div>
  )
}

interface MenuItemProps {
  label: string
  danger?: boolean
  disabled?: boolean
  autoFocus?: boolean
  /** Marca a opção escolhida em um menu de seleção única (`menuitemradio`). */
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
  /** Marcador antes do texto (ex.: a cor de um rótulo). */
  leading?: ReactNode
  autoFocus?: boolean
  onToggle: () => void
}

/** Opção que liga/desliga um filtro (`menuitemcheckbox`); o menu continua aberto ao alternar. */
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

/** Divisória entre grupos de opções. */
export function MenuSeparator() {
  return <div className="ui-menu-separator" role="separator" />
}
