import { useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import './segmented-control.css'

interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  trailing?: ReactNode
  disabled?: boolean
  /** Classe extra da opção (ex.: cor de um contador em `trailing`). */
  className?: string
}

interface SegmentedControlProps<T extends string> {
  options: Array<SegmentedOption<T>>
  value: T
  onChange: (value: T) => void
  ariaLabel: string
  /** `stacked`: lista vertical de opções (formulários); `inline`: trilho horizontal compacto (barras de ferramentas). */
  layout?: 'stacked' | 'inline'
  /** Altura das opções no layout `inline`. */
  size?: 'sm' | 'md'
  className?: string
}

/**
 * Grupo de opções mutuamente exclusivas (`role="radiogroup"`). Segue o padrão
 * WAI-ARIA de radiogroup: só a opção marcada entra na ordem de Tab e as setas
 * (e Home/End) movem foco e seleção juntos, pulando opções desabilitadas.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  layout = 'stacked',
  size = 'md',
  className,
}: SegmentedControlProps<T>) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const enabledIndexes = options.flatMap((option, index) => (option.disabled ? [] : [index]))
  const checkedIndex = options.findIndex((option) => option.value === value)
  // Sem opção marcada (ou marcada desabilitada), a primeira habilitada recebe o Tab.
  const tabStop = checkedIndex >= 0 && !options[checkedIndex].disabled ? checkedIndex : enabledIndexes[0]

  const select = (index: number) => {
    optionRefs.current[index]?.focus()
    if (options[index].value !== value) onChange(options[index].value)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (enabledIndexes.length === 0) return
    const position = enabledIndexes.indexOf(index)
    const step = (delta: number) =>
      enabledIndexes[(position + delta + enabledIndexes.length) % enabledIndexes.length]
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault()
        select(step(1))
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault()
        select(step(-1))
        break
      case 'Home':
        event.preventDefault()
        select(enabledIndexes[0])
        break
      case 'End':
        event.preventDefault()
        select(enabledIndexes[enabledIndexes.length - 1])
        break
      default:
        break
    }
  }

  const groupClass = [
    'ui-segmented',
    `ui-segmented--${layout}`,
    layout === 'inline' && size === 'sm' ? 'ui-segmented--sm' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={groupClass} role="radiogroup" aria-label={ariaLabel}>
      {options.map((option, index) => {
        const isActive = option.value === value
        const optionClass = ['ui-segmented-option', isActive ? 'ui-segmented-option--active' : null, option.className]
          .filter(Boolean)
          .join(' ')
        return (
          <button
            key={option.value}
            ref={(element) => {
              optionRefs.current[index] = element
            }}
            type="button"
            role="radio"
            aria-checked={isActive}
            disabled={option.disabled}
            tabIndex={index === tabStop ? 0 : -1}
            className={optionClass}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            <span className="ui-segmented-label">{option.label}</span>
            {/* Espaço só para o nome acessível ("Falhas 2"); no flex não ocupa largura. */}
            {option.trailing != null && ' '}
            {option.trailing}
          </button>
        )
      })}
    </div>
  )
}
