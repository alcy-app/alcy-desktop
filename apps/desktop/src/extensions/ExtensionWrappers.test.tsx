import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ExtensionWrappers } from './ExtensionWrappers'

function Outer({ children }: { children: ReactNode }) {
  return <section aria-label="outer">{children}</section>
}

function Inner({ children }: { children: ReactNode }) {
  return <section aria-label="inner">{children}</section>
}

vi.mock('./registry', () => ({
  APP_EXTENSIONS: [
    { id: 'first', AppWrapper: Outer },
    { id: 'no-wrapper' },
    { id: 'second', AppWrapper: Inner },
  ],
}))

describe('ExtensionWrappers', () => {
  it('nests the wrappers in extension order, the first one outermost', () => {
    render(
      <ExtensionWrappers>
        <p>app</p>
      </ExtensionWrappers>,
    )

    const outer = screen.getByRole('region', { name: 'outer' })
    const inner = screen.getByRole('region', { name: 'inner' })
    expect(outer).toContainElement(inner)
    expect(inner).toContainElement(screen.getByText('app'))
  })
})
