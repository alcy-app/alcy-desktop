import { createContext } from 'react'

export type ToastKind = 'success' | 'error'

export interface ToastContextValue {
  /** Sucesso some sozinho após alguns segundos; erro fica até o dismiss manual. */
  showToast: (text: string, kind?: ToastKind) => void
}

export const ToastContext = createContext<ToastContextValue | null>(null)
