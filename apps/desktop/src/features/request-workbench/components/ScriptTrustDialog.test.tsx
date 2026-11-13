import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '../../../test-utils'
import type { RequestSummary } from '../collection-tree'
import { ScriptTrustDialog, type ScriptTrustEntry } from './ScriptTrustDialog'

function entry(id: string, pre: string, post = ''): ScriptTrustEntry {
  const request = { id, name: id, protocol: 'rest', content: { preRequestScript: pre, postResponseScript: post } } as unknown as RequestSummary
  return { path: ['API'], request }
}

function renderDialog(entries: ScriptTrustEntry[]) {
  return render(
    <ScriptTrustDialog
      title="Trust?"
      description="Scripts"
      entries={entries}
      confirmLabel="Trust"
      declineLabel="Do not trust"
      onConfirm={vi.fn()}
      onDecline={vi.fn()}
    />,
  )
}

describe('ScriptTrustDialog', () => {
  it('lists the npm packages trusting the scripts would download', () => {
    renderDialog([
      entry('a', "const dayjs = require('npm:dayjs@1.11.13')", "pm.require('npm:@scope/pkg@2.0.0')"),
      entry('b', "require('npm:dayjs@1.11.13'); require('lodash')"),
    ])

    expect(screen.getByText(/estes 2 pacote\(s\) npm/)).toBeInTheDocument()
    expect(screen.getByText('npm:dayjs@1.11.13')).toBeInTheDocument()
    expect(screen.getByText('npm:@scope/pkg@2.0.0')).toBeInTheDocument()
    expect(screen.queryByText('npm:lodash')).not.toBeInTheDocument()
  })

  it('says nothing about packages when no script requires one', () => {
    renderDialog([entry('a', "const _ = require('lodash')")])

    expect(screen.queryByText(/pacote\(s\) npm/)).not.toBeInTheDocument()
  })
})
