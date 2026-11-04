import { useState } from 'react'
import { createPortal } from 'react-dom'
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '../../test-utils'
import { useAgentPanelHost } from './use-agent-panel-host'

function Counter() {
  const [count, setCount] = useState(0)
  return (
    <button type="button" onClick={() => setCount((current) => current + 1)}>
      {`count ${count}`}
    </button>
  )
}

function MovingPanel({ inSecond }: { inSecond: boolean }) {
  const [first, setFirst] = useState<HTMLDivElement | null>(null)
  const [second, setSecond] = useState<HTMLDivElement | null>(null)
  const host = useAgentPanelHost(inSecond ? second : first)
  return (
    <>
      <div data-testid="first" ref={setFirst} />
      {inSecond && <div data-testid="second" ref={setSecond} />}
      {createPortal(<Counter />, host)}
    </>
  )
}

describe('useAgentPanelHost', () => {
  it('moves the rendered panel between places without remounting it', () => {
    const { rerender } = render(<MovingPanel inSecond={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'count 0' }))
    expect(screen.getByTestId('first')).toContainElement(screen.getByRole('button', { name: 'count 1' }))

    rerender(<MovingPanel inSecond />)
    expect(screen.getByTestId('second')).toContainElement(screen.getByRole('button', { name: 'count 1' }))

    // The place going away sends the panel back, still with its state.
    rerender(<MovingPanel inSecond={false} />)
    expect(screen.getByTestId('first')).toContainElement(screen.getByRole('button', { name: 'count 1' }))
  })
})
