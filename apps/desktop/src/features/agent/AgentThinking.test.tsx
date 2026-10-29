import type { ReactNode } from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import { LANGUAGE_STORAGE_KEY } from '../../shared/i18n/translations'
import { AgentThinking } from './AgentThinking'

function wrapper({ children }: { children: ReactNode }) { return <LanguageProvider>{children}</LanguageProvider> }

afterEach(() => vi.useRealTimers())

describe('AgentThinking', () => {
  it('rotates themed copy with a stable accessible status and stops its timer on unmount', () => {
    vi.useFakeTimers()
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'pt-BR')
    const { unmount } = render(<AgentThinking />, { wrapper })
    expect(screen.getByRole('status', { name: 'O Alcy está pensando' })).toBeInTheDocument()
    expect(screen.getByText('Farejando a próxima rota…')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(4000))
    expect(screen.getByText('Explorando a floresta de endpoints…')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByRole('status', { name: 'O Alcy está pensando' })).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(4000))
    expect(screen.getByText('Desembaraçando os chifres do JSON…')).toBeInTheDocument()
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the interface language for both visible copy and the accessible label', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en')
    render(<AgentThinking />, { wrapper })
    expect(screen.getByRole('status', { name: 'Alcy is thinking' })).toBeInTheDocument()
    expect(screen.getByText('Sniffing out the next route…')).toBeInTheDocument()
  })
})
