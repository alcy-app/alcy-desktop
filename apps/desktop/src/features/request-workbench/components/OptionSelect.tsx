import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon, ChevronDownIcon } from '../../../shared/ui/icons'
import './option-select.css'

export interface SelectOption<T extends string> {
  value: T
  label: string
}

interface OptionSelectProps<T extends string> {
  id: string
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
}

interface PopupPosition {
  left: number
  width: number
  top?: number
  bottom?: number
}

const POPUP_GAP_PX = 4
const POPUP_MAX_HEIGHT_PX = 280

/** Seleção única com lista própria (`role="listbox"`), no lugar do `<select>` nativo: o popup segue o tema,
 * mostra a opção atual com um check e navega por teclado (setas, Home/End, Enter/Espaço, Escape). A lista
 * é renderizada em portal para não ser cortada por contêineres com scroll, como os modais. */
export function OptionSelect<T extends string>({ id, value, options, onChange }: OptionSelectProps<T>) {
  const listId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [position, setPosition] = useState<PopupPosition | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const isOpen = position !== null
  const selected = options.find((option) => option.value === value)

  const close = () => setPosition(null)

  const open = () => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const height = Math.min(options.length * 32 + 8, POPUP_MAX_HEIGHT_PX)
    const fitsBelow = rect.bottom + POPUP_GAP_PX + height <= window.innerHeight
    setPosition(
      fitsBelow
        ? { left: rect.left, width: rect.width, top: rect.bottom + POPUP_GAP_PX }
        : { left: rect.left, width: rect.width, bottom: window.innerHeight - rect.top + POPUP_GAP_PX },
    )
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)))
  }

  const choose = (index: number) => {
    const option = options[index]
    if (option) onChange(option.value)
    close()
    triggerRef.current?.focus()
  }

  useEffect(() => {
    if (!isOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || listRef.current?.contains(target)) return
      close()
    }
    // Rolar a página tira o popup (posição fixa) de junto do gatilho, então fecha;
    // rolar a própria lista, quando ela é maior que a altura máxima, não.
    const onScroll = (event: Event) => {
      if (listRef.current?.contains(event.target as Node)) return
      close()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    listRef.current?.children[activeIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [isOpen, activeIndex])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!isOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        open()
      }
      return
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActiveIndex((index) => Math.min(index + 1, options.length - 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setActiveIndex((index) => Math.max(index - 1, 0))
        break
      case 'Home':
        event.preventDefault()
        setActiveIndex(0)
        break
      case 'End':
        event.preventDefault()
        setActiveIndex(options.length - 1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        choose(activeIndex)
        break
      case 'Escape':
        // Fecha só a lista; sem isto o Escape também fecharia o modal que a contém.
        event.preventDefault()
        event.stopPropagation()
        close()
        break
      case 'Tab':
        close()
        break
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="ui-option-select"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        aria-activedescendant={isOpen ? `${listId}-${activeIndex}` : undefined}
        onClick={() => (isOpen ? close() : open())}
        onKeyDown={onKeyDown}
      >
        <span className="ui-option-select-value">{selected?.label}</span>
        <ChevronDownIcon
          size={12}
          className={isOpen ? 'ui-option-select-chevron ui-option-select-chevron--open' : 'ui-option-select-chevron'}
        />
      </button>

      {isOpen &&
        createPortal(
          <ul
            ref={listRef}
            id={listId}
            className="ui-option-select-list"
            role="listbox"
            style={{ ...position, maxHeight: POPUP_MAX_HEIGHT_PX }}
          >
            {options.map((option, index) => (
              <li
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={option.value === value}
                className={[
                  'ui-option-select-option',
                  index === activeIndex ? 'ui-option-select-option--active' : null,
                  option.value === value ? 'ui-option-select-option--selected' : null,
                ]
                  .filter(Boolean)
                  .join(' ')}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
              >
                <span>{option.label}</span>
                {option.value === value && <CheckIcon size={12} />}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </>
  )
}
