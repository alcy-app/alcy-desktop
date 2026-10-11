import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HAR_REDACTION_STORAGE_KEY } from './security-preferences'
import { SecurityPreferencesProvider } from './SecurityPreferencesProvider'
import { useSecurityPreferences } from './use-security-preferences'

function Probe() {
  const { redactHarSensitiveData, setRedactHarSensitiveData } = useSecurityPreferences()
  return <button onClick={() => setRedactHarSensitiveData(!redactHarSensitiveData)}>{String(redactHarSensitiveData)}</button>
}

describe('SecurityPreferencesProvider', () => {
  it('oculta dados sensíveis do HAR por padrão', () => {
    render(<SecurityPreferencesProvider><Probe /></SecurityPreferencesProvider>)
    expect(screen.getByRole('button')).toHaveTextContent('true')
  })

  it('mantém a proteção ligada com valor salvo inválido', () => {
    window.localStorage.setItem(HAR_REDACTION_STORAGE_KEY, 'talvez')
    render(<SecurityPreferencesProvider><Probe /></SecurityPreferencesProvider>)
    expect(screen.getByRole('button')).toHaveTextContent('true')
  })

  it('respeita o opt-out salvo', () => {
    window.localStorage.setItem(HAR_REDACTION_STORAGE_KEY, 'false')
    render(<SecurityPreferencesProvider><Probe /></SecurityPreferencesProvider>)
    expect(screen.getByRole('button')).toHaveTextContent('false')
  })

  it('troca e persiste a preferência', () => {
    render(<SecurityPreferencesProvider><Probe /></SecurityPreferencesProvider>)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button')).toHaveTextContent('false')
    expect(window.localStorage.getItem(HAR_REDACTION_STORAGE_KEY)).toBe('false')
  })
})
