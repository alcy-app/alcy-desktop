import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLanguage } from '../i18n/use-language'
import { ToastContext, type ToastKind } from './toast-context'
import { AlertIcon, CheckIcon, CloseIcon } from './icons'
import { IconButton } from './IconButton'
import { logger } from '../logging/logger'
import './toast.css'

const SUCCESS_AUTO_DISMISS_MS = 3000
const LEAVE_ANIMATION_MS = 200

interface ToastMessage {
  id: number
  kind: ToastKind
  text: string
  /** Quantas vezes a mesma mensagem foi mostrada enquanto estava na tela. */
  count: number
  leaving: boolean
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  // Espelho síncrono de `toasts`: chamadas seguidas no mesmo tick (ex.: um
  // lote de importação) precisam enxergar o toast que a anterior criou.
  const toastsRef = useRef<ToastMessage[]>([])
  const dismissTimersRef = useRef(new Map<number, number>())
  const nextIdRef = useRef(0)

  const update = useCallback((change: (current: ToastMessage[]) => ToastMessage[]) => {
    toastsRef.current = change(toastsRef.current)
    setToasts(toastsRef.current)
  }, [])

  const dismiss = useCallback(
    (id: number) => {
      window.clearTimeout(dismissTimersRef.current.get(id))
      dismissTimersRef.current.delete(id)
      update((current) => current.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)))
      window.setTimeout(() => {
        update((current) => current.filter((toast) => toast.id !== id))
      }, LEAVE_ANIMATION_MS)
    },
    [update],
  )

  const showToast = useCallback(
    (text: string, kind: ToastKind = 'success') => {
      // Todo erro mostrado ao usuário fica no log local, para diagnóstico.
      if (kind === 'error') logger.warn('toast', text)
      // A mesma mensagem ainda na tela se junta à existente (com contador)
      // em vez de empilhar um toast idêntico por ocorrência.
      const existing = toastsRef.current.find((toast) => !toast.leaving && toast.kind === kind && toast.text === text)
      let id: number
      if (existing) {
        id = existing.id
        update((current) => current.map((toast) => (toast.id === id ? { ...toast, count: toast.count + 1 } : toast)))
      } else {
        nextIdRef.current += 1
        id = nextIdRef.current
        update((current) => [...current, { id, kind, text, count: 1, leaving: false }])
      }
      if (kind === 'success') {
        window.clearTimeout(dismissTimersRef.current.get(id))
        dismissTimersRef.current.set(
          id,
          window.setTimeout(() => dismiss(id), SUCCESS_AUTO_DISMISS_MS),
        )
      }
    },
    [dismiss, update],
  )

  const value = useMemo(() => ({ showToast }), [showToast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

function ToastViewport({ toasts, onDismiss }: { toasts: ToastMessage[]; onDismiss: (id: number) => void }) {
  const { t } = useLanguage()

  return createPortal(
    <div className="ui-toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`ui-toast ui-toast--${toast.kind}${toast.leaving ? ' ui-toast--leaving' : ''}`}
          role={toast.kind === 'error' ? 'alert' : 'status'}
        >
          {toast.kind === 'success' ? (
            <CheckIcon size={13} className="ui-toast-icon" />
          ) : (
            <AlertIcon size={13} className="ui-toast-icon" />
          )}
          <span className="ui-toast-text">{toast.text}</span>
          {toast.count > 1 && (
            <span className="ui-toast-count" aria-label={t('toasts.repeatedCount', { count: toast.count })}>
              ×{toast.count}
            </span>
          )}
          <IconButton icon={<CloseIcon size={11} />} label={t('common.dismiss')} onClick={() => onDismiss(toast.id)} />
        </div>
      ))}
    </div>,
    document.body,
  )
}
