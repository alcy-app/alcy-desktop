import { useContext } from 'react'
import { ProxyContext, type ProxyContextValue } from './proxy-context'

export function useProxy(): ProxyContextValue {
  const context = useContext(ProxyContext)
  if (!context) {
    throw new Error('useProxy precisa ser usado dentro de ProxyProvider')
  }
  return context
}
