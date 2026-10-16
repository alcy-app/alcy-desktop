import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '../../../test-utils'
import { TOOLTIP_DELAY_MS } from '../../../shared/ui/use-tooltip'
import { initialImportVariables, type ImportVariablesState } from '../import-variables'
import { ImportVariablesReview } from './ImportVariablesReview'

const state = initialImportVariables({
  id: 'import-1',
  format: 'postman',
  title: 'Customer API',
  collectionCount: 1,
  folderCount: 0,
  requestCount: 1,
  environmentCount: 1,
  supportsDocumentation: false,
  scriptCount: 0,
  warningCount: 0,
  environmentNames: ['Dev'],
  collectionNames: ['Customer API'],
  variables: [
    { key: 'env:0:host', name: 'host', value: 'dev', valueTruncated: false, sensitive: false, origin: { kind: 'environment', index: 0 }, included: true },
    { key: 'collection:0:token', name: 'token', value: 'abc', valueTruncated: false, sensitive: true, origin: { kind: 'collection', index: 0 }, included: true },
    { key: 'ref:apiKey', name: 'apiKey', value: '', valueTruncated: false, sensitive: true, origin: { kind: 'referenced' }, included: false },
  ],
})

function renderReview(current: ImportVariablesState = state) {
  const onChange = vi.fn()
  render(
    <ImportVariablesReview
      state={current}
      environmentNames={['Dev']}
      collectionNames={['Customer API']}
      existingEnvironments={[{ id: 'qa', name: 'QA', variableNames: ['host'] }]}
      onChange={onChange}
    />,
  )
  return onChange
}

describe('ImportVariablesReview', () => {
  it('shows each variable with its destination and keeps collection variables non-sensitive', () => {
    renderReview()

    const names = screen.getAllByRole('textbox', { name: 'Nome' }) as HTMLInputElement[]
    expect(names.map((input) => input.value)).toEqual(['host', 'token', 'apiKey'])
    const destinations = screen.getAllByRole('combobox', { name: 'Destino' }) as HTMLSelectElement[]
    expect(destinations.map((select) => select.value)).toEqual(['imported:0', 'collection:0', 'imported:0'])
    const sensitive = screen.getAllByRole('checkbox', { name: 'Sensível' }) as HTMLInputElement[]
    expect(sensitive[1].checked).toBe(false)
    expect(sensitive[1].disabled).toBe(true)
    expect(screen.getByText('Sem definição')).toBeInTheDocument()
  })

  it('explains on hover why collection variables cannot be sensitive', () => {
    vi.useFakeTimers()
    try {
      renderReview()
      const [environmentToggle, collectionToggle] = screen.getAllByRole('checkbox', { name: 'Sensível' })

      fireEvent.mouseEnter(environmentToggle.closest('.ui-tooltip-host') ?? environmentToggle)
      act(() => {
        vi.advanceTimersByTime(TOOLTIP_DELAY_MS)
      })
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

      fireEvent.mouseEnter(collectionToggle.closest('.ui-tooltip-host')!)
      act(() => {
        vi.advanceTimersByTime(TOOLTIP_DELAY_MS)
      })
      expect(screen.getByRole('tooltip')).toHaveTextContent('Não é possível marcar como sensível uma variável de Collection ou de pasta')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a rename and warns when an existing environment value is replaced', () => {
    const onChange = renderReview({
      ...state,
      rows: state.rows.map((row) => (row.key === 'env:0:host' ? { ...row, destination: 'existing:qa' } : row)),
    })

    expect(screen.getByText('Substitui o valor atual em QA.')).toBeInTheDocument()
    fireEvent.change(screen.getAllByRole('textbox', { name: 'Nome' })[0], { target: { value: 'baseUrl' } })
    expect(onChange.mock.calls[0][0].rows[0].name).toBe('baseUrl')
  })

  it('asks for the new environment name when a variable goes there', () => {
    renderReview({
      ...state,
      newEnvironmentName: '',
      rows: state.rows.map((row) => (row.key === 'ref:apiKey' ? { ...row, include: true, destination: 'new' } : row)),
    })

    expect(screen.getByText('Informe o nome do novo ambiente.')).toBeInTheDocument()
  })
})
