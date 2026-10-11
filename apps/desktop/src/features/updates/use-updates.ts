import { useContext } from 'react'
import { UpdatesContext, type UpdatesContextValue } from './update-context'

export function useUpdates(): UpdatesContextValue {
  const context = useContext(UpdatesContext)
  if (!context) {
    throw new Error('useUpdates precisa ser usado dentro de UpdateProvider')
  }
  return context
}
