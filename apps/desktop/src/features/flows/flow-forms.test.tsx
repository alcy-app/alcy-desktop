import { useState, type ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlowForm, FlowFormField, FlowPresentation, FormAnswers } from '../../bindings/flow-forms'
import { listFlowFormOptions } from '../../bindings/flow-forms'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import { LANGUAGE_STORAGE_KEY } from '../../shared/i18n/translations'
import { FlowFormView } from './FlowFormView'
import { FlowPanels } from './FlowPanels'
import { FlowFormEditor } from './FlowFormEditor'
import { initialFormAnswers } from './form-model'
import { dtoFromFlowNode, flowNodeFromDto } from './use-flows-state'
import { renameGraphNode } from './node-identifiers'
import type { FlowNodeState } from './flows.types'

vi.mock('../../bindings/flow-forms', () => ({ listFlowFormOptions: vi.fn() }))

function wrapper({ children }: { children: ReactNode }) { return <LanguageProvider>{children}</LanguageProvider> }
const field = (update: Partial<FlowFormField>): FlowFormField => ({ id: 'quantity', label: 'Quantity', kind: 'number', description: '', required: true, initialValue: '', min: 1, max: 5, step: 2, multiple: false, options: [], source: null, ...update })
const definition = (fields: FlowFormField[], collapsed = false): FlowForm => ({ title: 'Order', description: 'Review your order', sections: [{ id: 'main', title: 'Details', collapsed, fields }] })

beforeEach(() => { localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en'); vi.mocked(listFlowFormOptions).mockReset() })

function FormHarness({ form, submit }: { form: FlowForm; submit: (answers: FormAnswers) => Promise<void> }) {
  const [answers, setAnswers] = useState(() => initialFormAnswers(form))
  return <FlowFormView form={form} answers={answers} onChange={setAnswers} onSubmit={() => submit(answers)} request={{ flowExecutionId: 'run', nodeId: 'human', waitId: 'wait-1' }} />
}

describe('flow forms', () => {
  it('expands invalid sections and checks numeric steps and required checkboxes before submitting typed values', async () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    render(<FormHarness form={definition([field({}), field({ id: 'approved', label: 'Approved', kind: 'checkbox' })], true)} submit={submit} />, { wrapper })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(submit).not.toHaveBeenCalled()
    expect(screen.getByText('Details').closest('details')).toHaveAttribute('open')
    fireEvent.change(screen.getByRole('spinbutton', { name: /Quantity/ }), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /Approved/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Enter a number within the configured limits and step.')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('spinbutton', { name: /Quantity/ }), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ quantity: 3, approved: true }))
  })

  it('keeps selections across pages and sends only source indices', async () => {
    vi.mocked(listFlowFormOptions).mockImplementation(async (_, __, offset) => offset === 0 ? { rows: [{ index: 0, cells: ['First'] }], total: 101, nextOffset: 100 } : { rows: [{ index: 100, cells: ['Last'] }], total: 101, nextOffset: null })
    const submit = vi.fn().mockResolvedValue(undefined)
    const form = definition([field({ id: 'products', label: 'Products', kind: 'result', multiple: true, source: { reference: '{{nodes.fetch.response.body}}', columns: [{ path: 'name', label: 'Name' }] } })])
    render(<FormHarness form={form} submit={submit} />, { wrapper })
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Products: First' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Products: Last' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    expect(await screen.findByRole('checkbox', { name: 'Products: First' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ products: [0, 100] }))
  })

  it('preserves both forms through DTO conversion and rewrites result sources on node rename', () => {
    const form = definition([field({ kind: 'result', source: { reference: '{{nodes.fetch.response.body.items}}', columns: [{ path: 'id', label: 'ID' }] } })])
    const nodes: FlowNodeState[] = [{ id: 'start', kind: 'start', form: definition([field({})]), position: { x: 0, y: 0 } }, { id: 'fetch', kind: 'display', template: '', position: { x: 100, y: 0 } }, { id: 'human', kind: 'humanAction', form, position: { x: 200, y: 0 } }]
    for (const node of nodes) expect(flowNodeFromDto(dtoFromFlowNode(node))).toEqual(node)
    const renamed = renameGraphNode(nodes, [], 'fetch', 'products')
    expect(renamed.nodes[2]).toMatchObject({ form: { sections: [{ fields: [{ source: { reference: '{{nodes.products.response.body.items}}' } }] }] } })
  })

  it('adds ordered sections and fields in the visual editor', () => {
    function Editor() { const [form, setForm] = useState(definition([])); return <FlowFormEditor form={form} onChange={setForm} /> }
    render(<Editor />, { wrapper })
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }))
    expect(screen.getByRole('textbox', { name: 'Identifier' })).toHaveValue('field')
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }))
    expect(screen.getAllByRole('textbox', { name: 'Identifier' }).map((input) => (input as HTMLInputElement).value)).toEqual(['field', 'field_2'])
    fireEvent.click(screen.getAllByRole('button', { name: 'Move up' }).at(-1)!)
    expect(screen.getAllByRole('textbox', { name: 'Identifier' }).map((input) => (input as HTMLInputElement).value)).toEqual(['field_2', 'field'])
  })

  it('keeps chosen panels fixed and allows keyboard positioning and resizing independently of graph coordinates', () => {
    const onChange = vi.fn()
    const node: FlowNodeState = { id: 'result', kind: 'display', template: '', position: { x: 900, y: 700 } }
    function Panels() {
      const [presentation, setPresentation] = useState<FlowPresentation>({ panels: [{ nodeId: 'result', title: '', x: 16, y: 32, width: 440, height: 400 }] })
      return <FlowPanels nodes={[node]} presentation={presentation} onChange={(next) => { onChange(next); setPresentation(next) }} statuses={{ result: { status: 'waitingForHuman', waitId: 'pending' } }} renderContent={() => <span>Output</span>} />
    }
    render(<Panels />, { wrapper })
    expect(screen.getByText('Waiting for human action')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Arrange panels' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'result: Move panel with arrow keys' }), { key: 'ArrowRight' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'result: Resize panel with arrow keys' }), { key: 'ArrowDown' })
    expect(onChange).toHaveBeenLastCalledWith({ panels: [expect.objectContaining({ x: 32, y: 32, width: 440, height: 416 })] })
    expect(node.position).toEqual({ x: 900, y: 700 })
  })
})
