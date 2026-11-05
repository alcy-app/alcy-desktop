import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import { LANGUAGE_STORAGE_KEY } from '../../shared/i18n/translations'
import type { SimpleNodeKindState } from './flows.types'
import { NodeInspectorPanel } from './NodeInspectorPanel'
import { numberSettingIssue } from './number-setting'
import { formatSleepDuration } from './simple-node-types'

type Selection = Extract<SimpleNodeKindState, { kind: 'while' | 'sleep' }>

function renderInspector(initial: Selection) {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en')
  const changes: SimpleNodeKindState[] = []
  function StatefulInspector() {
    const [config, setConfig] = useState<SimpleNodeKindState>(initial)
    return <NodeInspectorPanel
      selection={{ id: 'node', ...(config as Selection) }}
      ancestorRequests={[]}
      ancestorLocalVariables={[]}
      environmentVariables={[]}
      collections={[]}
      onLabelChange={() => {}}
      onConditionChange={() => {}}
      onRequestChange={() => {}}
      onConfigChange={(_, next) => {
        setConfig(next)
        changes.push(next)
      }}
      onLoadConfigChange={() => {}}
      onEditInlineRequest={() => {}}
      mockStartOptions={[]}
      selectedMockStart={null}
      savedMockServers={[]}
      onEditInlineMockServer={() => {}}
      onClose={() => {}}
    />
  }
  render(<LanguageProvider><StatefulInspector /></LanguageProvider>)
  return changes
}

describe('numeric block settings', () => {
  it('accepts a variable as the While iteration limit', () => {
    const changes = renderInspector({ kind: 'while', condition: { left: '1', operator: 'equals', right: '1' }, maxIterations: '100' })

    fireEvent.change(screen.getByLabelText('Maximum iterations'), { target: { value: '{{loop-count}}' } })

    expect(changes.at(-1)).toMatchObject({ kind: 'while', maxIterations: '{{loop-count}}' })
    expect(screen.queryByText(/Use a whole number/)).toBeNull()
  })

  it('flags a literal limit out of range but keeps it editable', () => {
    const changes = renderInspector({ kind: 'while', condition: { left: '1', operator: 'equals', right: '1' }, maxIterations: '100' })

    fireEvent.change(screen.getByLabelText('Maximum iterations'), { target: { value: '0' } })

    expect(changes.at(-1)).toMatchObject({ maxIterations: '0' })
    expect(screen.getByText('Use a value between 1 and 10000.')).toBeInTheDocument()
  })

  it('stores a Sleep typed in seconds as milliseconds and a variable as typed, in ms', () => {
    const changes = renderInspector({ kind: 'sleep', durationMs: '2000' })
    const duration = screen.getByLabelText('Duration')
    expect(duration).toHaveValue('2')

    fireEvent.change(duration, { target: { value: '1.5' } })
    expect(changes.at(-1)).toEqual({ kind: 'sleep', durationMs: '1500' })

    fireEvent.change(duration, { target: { value: '{{delay}}' } })
    expect(changes.at(-1)).toEqual({ kind: 'sleep', durationMs: '{{delay}}' })
    expect(screen.getByLabelText('Unit')).toBeDisabled()
    expect(screen.getByText('The variable value is read in milliseconds.')).toBeInTheDocument()
  })
})

describe('numberSettingIssue', () => {
  it('leaves templates to the run and checks literal numbers', () => {
    expect(numberSettingIssue('{{n}}', { min: 1, integer: true })).toBeNull()
    expect(numberSettingIssue('5', { min: 1, max: 10, integer: true })).toBeNull()
    expect(numberSettingIssue('1.5', { integer: true })).toBe('notANumber')
    expect(numberSettingIssue('abc', {})).toBe('notANumber')
    expect(numberSettingIssue('', {})).toBe('notANumber')
    expect(numberSettingIssue('11', { max: 10 })).toBe('outOfRange')
  })

  it('formats literal and variable durations', () => {
    expect(formatSleepDuration('500')).toBe('500 ms')
    expect(formatSleepDuration('2000')).toBe('2 s')
    expect(formatSleepDuration('{{delay}}')).toBe('{{delay}} ms')
  })
})
