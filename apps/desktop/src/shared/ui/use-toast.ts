import { useContext } from 'react'
import { ToastContext, type ToastContextValue } from './toast-context'

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext)
  if (!value) throw new Error('useToast requer um ToastProvider acima na árvore')
  return value
}
