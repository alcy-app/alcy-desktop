import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { DiffHunks } from './DiffHunks'

describe('DiffHunks', () => {
  it('numera cada lado só nas linhas que existem nele e marca adições e remoções', () => {
    const { container } = render(
      <DiffHunks
        hunks={[
          {
            oldStart: 10,
            newStart: 20,
            lines: [
              { kind: 'context', text: 'a' },
              { kind: 'removed', text: 'b' },
              { kind: 'added', text: 'c' },
              { kind: 'context', text: 'd' },
            ],
          },
        ]}
      />,
    )

    expect(container.querySelector('.ui-diff-hunk-header')).toHaveTextContent('@@ -10 +20 @@')
    const rows = [...container.querySelectorAll('.ui-diff-line')].map((row) =>
      [...row.children].map((cell) => cell.textContent),
    )
    expect(rows).toEqual([
      ['10', '20', ' ', 'a'],
      ['11', '', '-', 'b'],
      ['', '21', '+', 'c'],
      ['12', '22', ' ', 'd'],
    ])
    expect(container.querySelector('.ui-diff-line--removed')).toHaveTextContent('b')
    expect(container.querySelector('.ui-diff-line--added')).toHaveTextContent('c')
  })
})
