import { describe, expect, it } from 'vitest'
import { translate, type TranslationKey } from '../../shared/i18n/translations'
import { createFlowFromTemplate, FLOW_TEMPLATES } from './flow-templates'
import { dtoFromFlowNode, flowNodeFromDto } from './use-flows-state'

const t = (key: TranslationKey) => translate('en', key)

describe('flow templates', () => {
  it.each(FLOW_TEMPLATES)('keeps $id editable through the existing storage representation', ({ id }) => {
    const flow = createFlowFromTemplate(id, t)
    expect(flow.nodes.map((node) => flowNodeFromDto(dtoFromFlowNode(node)))).toEqual(flow.nodes)
    expect(flow.nodes.filter((node) => node.kind === 'start')).toHaveLength(1)
    const nodes = new Map(flow.nodes.map((node) => [node.id, node]))
    expect(nodes.size).toBe(flow.nodes.length)
    for (const edge of flow.edges) {
      expect(nodes.has(edge.sourceNodeId)).toBe(true)
      expect(nodes.has(edge.targetNodeId)).toBe(true)
      const source = nodes.get(edge.sourceNodeId)!
      expect(source.kind).not.toBe('note')
      expect(nodes.get(edge.targetNodeId)?.kind).not.toBe('note')
      switch (source.kind) {
        case 'inlineRequest': expect(['success', 'failure']).toContain(edge.sourceHandle); break
        case 'if': expect(['true', 'false']).toContain(edge.sourceHandle); break
        case 'while': expect(['loop', 'done']).toContain(edge.sourceHandle); break
        case 'load': expect(source.loadKind === 'scenario' ? ['iteration', 'done'] : ['success']).toContain(edge.sourceHandle); break
        default: expect(edge.sourceHandle).toBeUndefined()
      }
    }
    // Every output reference must point to an ancestor, never a missing node or a later request.
    const ancestors = (nodeId: string): string[] => flow.edges.filter((edge) => edge.targetNodeId === nodeId).flatMap((edge) => [edge.sourceNodeId, ...ancestors(edge.sourceNodeId)])
    for (const node of flow.nodes.filter((node) => node.kind !== 'note')) {
      const references = [...JSON.stringify(node).matchAll(/\{\{nodes\.([^.]+)\./g)].map((match) => match[1])
      for (const reference of references) expect(ancestors(node.id)).toContain(reference)
    }
  })

  it('starts blank and isolates flow, request and edge identities between copies', () => {
    const blank = createFlowFromTemplate('blank', t)
    expect(blank.nodes).toEqual([{ id: 'start', kind: 'start', position: { x: 0, y: 0 } }])
    expect(blank.edges).toEqual([])
    const first = createFlowFromTemplate('authentication', t)
    const second = createFlowFromTemplate('authentication', t)
    expect(second.id).not.toBe(first.id)
    const firstIds = new Set(first.edges.map((edge) => edge.id))
    expect(second.edges.every((edge) => !firstIds.has(edge.id))).toBe(true)
    const requests = (flow: typeof first) => flow.nodes.filter((node) => node.kind === 'inlineRequest').map((node) => node.request)
    expect(requests(second).every((request) => !requests(first).some((other) => other.id === request.id))).toBe(true)
    requests(first)[0].content.headers[0].value = 'changed'
    expect(requests(second)[0].content.headers[0].value).toBe('application/json')
    expect(requests(second)[1].content.authentication).toEqual({ type: 'bearer', token: '{{nodes.login.response.body.token}}' })
  })

  it('reaches the condition for successful and unsuccessful HTTP statuses and keeps repeat completion outside its body', () => {    const condition = createFlowFromTemplate('condition', t)
    expect(condition.edges.filter((edge) => edge.targetNodeId === 'status').map((edge) => edge.sourceHandle)).toEqual(['success', 'failure'])
    const repeat = createFlowFromTemplate('repeat', t)
    expect(repeat.edges).toContainEqual(expect.objectContaining({ sourceNodeId: 'repeat', targetNodeId: 'complete', sourceHandle: 'done' }))
    expect(repeat.edges.some((edge) => edge.targetNodeId === 'repeat' && edge.sourceNodeId !== 'initialize')).toBe(false)
  })

  it('ships an order form whose request targets its own inline mock', () => {
    const flow = createFlowFromTemplate('orderForm', t)
    const start = flow.nodes.find((node) => node.kind === 'start')
    const fields = start?.kind === 'start' ? start.form?.sections.flatMap((section) => section.fields) ?? [] : []
    expect(fields.map((field) => field.kind)).toEqual(expect.arrayContaining(['text', 'number', 'select', 'checkbox']))
    const mock = flow.nodes.find((node) => node.kind === 'mockStart')
    expect(mock?.kind === 'mockStart' ? mock.source.type : null).toBe('inline')
    const request = flow.nodes.find((node) => node.kind === 'inlineRequest')
    expect(request?.kind === 'inlineRequest' ? request.request.content.endpointUrl : null).toBe('{{nodes.mock.server.url}}/orders')
    expect(request?.kind === 'inlineRequest' ? request.request.content.body : null).toEqual(expect.objectContaining({ content: expect.stringContaining('{{nodes.start.form.quantity}}') }))
  })
})
