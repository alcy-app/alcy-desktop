import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import { fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '../../test-utils'
import { emptyRequestContent } from '../request-workbench/collection-tree'
import { FlowRequestCard } from './FlowRequestCard'
import { RequestNode, type RequestNodeType } from './RequestNode'
import { InlineRequestNode } from './InlineRequestNode'
import { simpleFlowNode, type SimpleFlowNodeType } from './simple-node-types'

const request = { id: 'customers', name: 'Customers', protocol: 'rest' as const, content: { ...emptyRequestContent('rest'), postResponseScript: 'pm.test("status", () => pm.expect(pm.response.code).to.equal(200));' } }

describe('compact request overview', () => {
  it('shows the endpoint and named output terminals while editing opens the inspector', () => {
    const onOpenSettings = vi.fn()
    render(<ReactFlowProvider><FlowRequestCard kind="request" request={request} onOpenSettings={onOpenSettings}><span>api.local/customers</span></FlowRequestCard></ReactFlowProvider>)
    expect(screen.getByText('api.local/customers')).toBeInTheDocument()
    expect(screen.getByText('Sucesso')).toBeInTheDocument()
    expect(screen.getByText('Falha')).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.queryByText(request.content.postResponseScript)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Abrir configurações deste node' }), { detail: 0 })
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('shows HTTP errors beside the failure terminal without inventing idle results', () => {
    const { container, rerender } = render(<ReactFlowProvider><FlowRequestCard kind="inlineRequest" request={request}>Input</FlowRequestCard></ReactFlowProvider>)
    expect(container.querySelectorAll('.flow-node-output-detail')).toHaveLength(0)
    rerender(<ReactFlowProvider><FlowRequestCard kind="inlineRequest" request={request} runStatus={{ status: 'success', statusCode: 404, durationMs: 45 }}>Input</FlowRequestCard></ReactFlowProvider>)
    expect(container.querySelector('.flow-node-output--negative')).toHaveTextContent('404')
    expect(container.querySelector('.flow-node-output--positive')).not.toHaveTextContent('404')
    expect(container.querySelector('.flow-node-body')).toHaveTextContent('Input')
  })

  it.each(['saved', 'inline'])('keeps URL variables highlighted in %s requests', (kind) => {
    const templatedRequest = { ...request, content: { ...request.content, endpointUrl: '{{base_url}}/users/{{nodes.login.response.body.id}}' } }
    const environmentVariables = [{ name: 'base_url', value: 'https://api.test', sensitive: false }]
    const noop = () => {}
    const data: RequestNodeType['data'] = { requestId: request.id, request: templatedRequest, runStatus: { status: 'idle' }, collections: [], environmentVariables, onSelectRequest: noop, onOpenSettings: noop, onDelete: noop, onDuplicate: noop }
    const savedProps = { id: 'saved', data } as NodeProps<RequestNodeType>
    const inline = simpleFlowNode('inline', { x: 0, y: 0 }, { kind: 'inlineRequest', request: templatedRequest })
    const inlineProps = { id: inline.id, data: { ...inline.data, environmentVariables } } as NodeProps<SimpleFlowNodeType>
    const { container } = render(<ReactFlowProvider>{kind === 'saved' ? <RequestNode {...savedProps} /> : <InlineRequestNode {...inlineProps} />}</ReactFlowProvider>)
    const tokens = [...container.querySelectorAll('.flow-url-variable')]
    expect(tokens.map(token => token.textContent)).toEqual(['{{base_url}}', '{{nodes.login.response.body.id}}'])
    expect(tokens[0]).toHaveAttribute('title', 'base_url = https://api.test')
    expect(tokens[1].getAttribute('title')).toBeTruthy()
    expect(container.querySelector('.flow-node-request-picker')).toHaveTextContent(templatedRequest.content.endpointUrl)
  })

  it('opens an inline request editor from its URL on a double click, not a single one', () => {
    const onEditRequest = vi.fn<() => void>()
    const inline = simpleFlowNode('inline', { x: 0, y: 0 }, { kind: 'inlineRequest', request })
    const props = { id: inline.id, data: { ...inline.data, onEditRequest: () => onEditRequest() } } as NodeProps<SimpleFlowNodeType>
    const { container } = render(<ReactFlowProvider><InlineRequestNode {...props} /></ReactFlowProvider>)
    const summary = container.querySelector('.flow-node-request-picker') as HTMLElement

    fireEvent.click(summary, { detail: 1 })
    expect(onEditRequest).not.toHaveBeenCalled()

    fireEvent.doubleClick(summary)
    expect(onEditRequest).toHaveBeenCalledOnce()
  })
})
