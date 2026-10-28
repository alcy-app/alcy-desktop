import { useContext } from 'react'
import { OnedriveContext, type OnedriveContextValue } from './onedrive-context'

export function useOnedrive(): OnedriveContextValue {
  const context = useContext(OnedriveContext)
  if (!context) {
    throw new Error('useOnedrive precisa ser usado dentro de OnedriveProvider')
  }
  return context
}
