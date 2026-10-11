import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon } from './icons'
import { IconButton } from './IconButton'
import { openModals } from './open-modals'
import './buttons.css'
import './modal.css'

/*
 * Fallback para quando a animação de saída não roda (jsdom, reduced-motion):
 * um pouco acima de --duration-fast para o onAnimationEnd chegar primeiro
 * quando a animação existe.
 */
const CLOSE_FALLBACK_MS = 220

const FOCUSABLE_SELECTOR = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)'

/*
 * Elementos que já dão significado próprio ao Enter (ativar um botão, quebrar
 * linha, escolher uma opção): neles o Enter não confirma o modal.
 */
const OWN_ENTER_SELECTOR =
  'button, a[href], textarea, select, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="menuitem"], [role="option"], [role="tab"], [role="treeitem"], [role="combobox"], [role="checkbox"], [role="switch"]'

const NON_TEXT_INPUT_TYPES = ['checkbox', 'radio', 'button', 'submit', 'reset', 'file']

function confirmsWithEnter(target: EventTarget | null, dialog: HTMLElement): boolean {
  if (!(target instanceof HTMLElement) || !dialog.contains(target)) return false
  if (target === dialog) return true
  if (target.closest(OWN_ENTER_SELECTOR)) return false
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.includes(target.type)
  return true
}

interface ModalProps {
  title: string
  closeAriaLabel: string
  /** Chamado quando o modal terminou de fechar (após a animação de saída). */
  onClose: () => void
  /** Sobrepõe o comportamento do Escape (padrão: fechar o modal). */
  onEscape?: () => void
  /**
   * Ação principal disparada pelo Enter (sem modificadores) quando o foco está
   * no próprio modal ou num campo de texto dele — não em botões, áreas de
   * texto ou controles que já tratam o Enter.
   */
  onEnter?: () => void
  /** Classe extra no painel, para largura/layout específicos do modal. */
  className?: string
  children: ReactNode | ((requestClose: () => void) => ReactNode)
}

export function Modal({ title, closeAriaLabel, onClose, onEscape, onEnter, className, children }: ModalProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [closing, setClosing] = useState(false)
  const closedRef = useRef(false)
  const onCloseRef = useRef(onClose)
  const onEscapeRef = useRef(onEscape)
  const onEnterRef = useRef(onEnter)
  useEffect(() => {
    onCloseRef.current = onClose
    onEscapeRef.current = onEscape
    onEnterRef.current = onEnter
  })

  const finishClose = useCallback(() => {
    if (closedRef.current) return
    closedRef.current = true
    onCloseRef.current()
  }, [])

  const requestClose = useCallback(() => {
    setClosing(true)
  }, [])

  useEffect(() => {
    if (!closing) return
    const timer = window.setTimeout(finishClose, CLOSE_FALLBACK_MS)
    return () => window.clearTimeout(timer)
  }, [closing, finishClose])

  useEffect(() => {
    const token = Symbol('modal')
    openModals.push(token)

    // Sem um filho com autoFocus, o foco vai para o painel: Enter/Esc agem
    // sobre o modal e o Tab começa dentro dele, não no que ficou por trás.
    const dialog = dialogRef.current
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus()

    function onKeyDown(event: KeyboardEvent) {
      if (openModals.at(-1) !== token) return
      if (event.key === 'Escape') {
        event.preventDefault()
        const escape = onEscapeRef.current
        if (escape) {
          escape()
        } else {
          requestClose()
        }
        return
      }
      if (event.key === 'Enter') {
        const enter = onEnterRef.current
        const plain = !(event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
        if (
          enter &&
          plain &&
          !event.repeat &&
          !event.isComposing &&
          !event.defaultPrevented &&
          !closedRef.current &&
          dialogRef.current &&
          confirmsWithEnter(event.target, dialogRef.current)
        ) {
          event.preventDefault()
          enter()
        }
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return

      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => !element.closest('[hidden], [inert]'),
      )
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (document.activeElement === dialogRef.current) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      openModals.splice(openModals.indexOf(token), 1)
    }
  }, [requestClose])

  return createPortal(
    <div
      className={closing ? 'ui-modal-backdrop ui-modal-backdrop--closing' : 'ui-modal-backdrop'}
      onMouseDown={requestClose}
    >
      <div
        ref={dialogRef}
        className={className ? `ui-modal ${className}` : 'ui-modal'}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
        onAnimationEnd={(event) => {
          if (closing && event.target === dialogRef.current) finishClose()
        }}
      >
        <div className="ui-modal-header">
          <h2 id={titleId} className="ui-modal-title">
            {title}
          </h2>
          <IconButton icon={<CloseIcon />} label={closeAriaLabel} onClick={requestClose} />
        </div>
        {typeof children === 'function' ? children(requestClose) : children}
      </div>
    </div>,
    document.body,
  )
}
