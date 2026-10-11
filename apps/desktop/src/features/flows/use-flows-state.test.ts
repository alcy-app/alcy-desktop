import { describe, expect, it } from 'vitest'
import { emptyRequestContent } from '../request-workbench/collection-tree'
import type { FlowNodeState } from './flows.types'
import { createFlowFromRequests, createLoadFlow, dtoFromFlowNode, flowNodeFromDto, START_NODE_ID } from './use-flows-state'

describe('conversão de nodes para o DTO', () => {
  it('leva a requisição avulsa inteira no formato de uma requisição de coleção e volta igual', () => {
    const node: FlowNodeState = {
      id: 'inline-1',
      kind: 'inlineRequest',
      position: { x: 10, y: 20 },
      request: {
        id: 'request-1',
        name: 'Avulsa',
        protocol: 'rest',
        content: { ...emptyRequestContent('rest'), endpointUrl: '{{host}}/users', method: 'put' },
      },
    }

    const dto = dtoFromFlowNode(node)

    expect(dto).toMatchObject({ kind: 'inlineRequest', request: { id: 'request-1', endpoint: '{{host}}/users', method: 'put' } })
    expect(flowNodeFromDto(dto)).toEqual(node)
  })

  it('mantém a configuração dos nodes simples', () => {
    const node: FlowNodeState = {
      id: 'while-1',
      kind: 'while',
      condition: { left: '{{i}}', operator: 'lessThan', right: '3' },
      maxIterations: 5,
      position: { x: 0, y: 0 },
    }
    expect(flowNodeFromDto(dtoFromFlowNode(node))).toEqual(node)
  })
})

describe('createFlowFromRequests', () => {
  it('liga o Start à primeira requisição e encadeia as demais pelo sucesso', () => {
    const flow = createFlowFromRequests('Usuários', ['a', 'b'])

    expect(flow.name).toBe('Usuários')
    const [start, first, second] = flow.nodes
    expect(start).toMatchObject({ id: START_NODE_ID, kind: 'start' })
    expect(first).toMatchObject({ kind: 'request', requestId: 'a' })
    expect(second).toMatchObject({ kind: 'request', requestId: 'b' })
    expect(flow.edges).toEqual([
      expect.objectContaining({ sourceNodeId: START_NODE_ID, targetNodeId: first.id }),
      expect.objectContaining({ sourceNodeId: first.id, targetNodeId: second.id, sourceHandle: 'success' }),
    ])
  })
})

describe('createLoadFlow', () => {
  it('cria um cenário executável ligado a uma requisição de carga', () => {
    const flow = createLoadFlow('Carga', { scenario: 'Scenario', request: 'Request' })

    expect(flow.executionKind).toBe('load')
    const [, scenario, request] = flow.nodes
    expect(scenario).toMatchObject({ kind: 'load', loadKind: 'scenario', label: 'Scenario' })
    expect(request).toMatchObject({ kind: 'load', loadKind: 'request', label: 'Request' })
    expect(JSON.parse((scenario as Extract<FlowNodeState, { kind: 'load' }>).config)).toMatchObject({ executor: 'sharedIterations', vus: 1, iterations: 1 })
    expect(JSON.parse((request as Extract<FlowNodeState, { kind: 'load' }>).config)).toMatchObject({ method: 'GET', redirectPolicy: 'follow' })
    expect(flow.edges).toEqual([
      expect.objectContaining({ sourceNodeId: START_NODE_ID, targetNodeId: scenario.id }),
      expect.objectContaining({ sourceNodeId: scenario.id, targetNodeId: request.id, sourceHandle: 'iteration' }),
    ])
  })
})
