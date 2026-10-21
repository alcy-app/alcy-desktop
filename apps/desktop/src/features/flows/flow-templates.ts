import type { TranslationKey } from '../../shared/i18n/translations'
import type { MockServerDto } from '../../bindings/mock-servers'
import type { FlowForm, FlowFormField, FlowFormSection } from '../../bindings/flow-forms'
import { emptyRequestContent, type RequestContent } from '../request-workbench/collection-tree'
import { FLOW_GEOMETRY as G } from './flow-geometry'
import type { FlowEdgeState, FlowNodeState, FlowSourceHandle, FlowState } from './flows.types'
import { defaultLoadNodeConfig } from './load-node-config'

export const FLOW_TEMPLATES = [
  { id: 'blank', nameKey: 'flows.templates.blank.name', descriptionKey: 'flows.templates.blank.description', executionKind: 'standard' },
  { id: 'authentication', nameKey: 'flows.templates.authentication.name', descriptionKey: 'flows.templates.authentication.description', executionKind: 'standard' },
  { id: 'chainedRequests', nameKey: 'flows.templates.chainedRequests.name', descriptionKey: 'flows.templates.chainedRequests.description', executionKind: 'standard' },
  { id: 'condition', nameKey: 'flows.templates.condition.name', descriptionKey: 'flows.templates.condition.description', executionKind: 'standard' },
  { id: 'repeat', nameKey: 'flows.templates.repeat.name', descriptionKey: 'flows.templates.repeat.description', executionKind: 'standard' },
  { id: 'orderForm', nameKey: 'flows.templates.orderForm.name', descriptionKey: 'flows.templates.orderForm.description', executionKind: 'standard' },
  { id: 'load', nameKey: 'flows.templates.load.name', descriptionKey: 'flows.templates.load.description', executionKind: 'load' },
] as const satisfies readonly { id: string; nameKey: TranslationKey; descriptionKey: TranslationKey; executionKind: FlowState['executionKind'] }[]

export type FlowTemplateId = typeof FLOW_TEMPLATES[number]['id']
type Translate = (key: TranslationKey) => string

/** Build an independent, editable graph using the existing persisted flow contract. */
export function createFlowFromTemplate(templateId: FlowTemplateId, t: Translate): FlowState {
  const definition = FLOW_TEMPLATES.find((template) => template.id === templateId)!
  const now = Date.now()
  const nodes: FlowNodeState[] = [{ id: 'start', kind: 'start', position: { x: 0, y: 0 } }]
  const edges: FlowEdgeState[] = []
  const position = (column: number, row = 0) => ({ x: column === 0 ? 0 : G.compactWidth + G.columnGap + (column - 1) * (G.width + G.columnGap), y: row * 256 })
  const connect = (sourceNodeId: string, targetNodeId: string, sourceHandle?: FlowSourceHandle) => {
    edges.push({ id: crypto.randomUUID(), sourceNodeId, targetNodeId, ...(sourceHandle ? { sourceHandle } : {}) })
  }
  const request = (id: string, nameKey: TranslationKey, url: string, column: number, content: Partial<RequestContent> = {}) => {
    nodes.push({ id, kind: 'inlineRequest', position: position(column), request: {
      id: crypto.randomUUID(), name: t(nameKey), protocol: 'rest',
      content: { ...emptyRequestContent('rest'), authentication: { type: 'none' }, endpointUrl: url, ...content },
    } })
  }
  const display = (id: string, template: string, column: number, row = 0) => {
    nodes.push({ id, kind: 'display', template, position: position(column, row) })
  }
  const formField = (id: string, labelKey: TranslationKey, kind: FlowFormField['kind'], extra: Partial<FlowFormField> = {}): FlowFormField => ({
    id, label: t(labelKey), description: '', kind, required: false, initialValue: '', min: null, max: null, step: null, options: [], source: null, multiple: false, ...extra,
  })
  const formSection = (id: string, titleKey: TranslationKey, fields: FlowFormField[], collapsed = false): FlowFormSection => ({ id, title: t(titleKey), collapsed, fields })

  switch (templateId) {
    case 'blank':
      break
    case 'authentication':
      request('login', 'flows.templates.loginRequest', '{{baseUrl}}/auth/login', 1, {
        method: 'post', body: { type: 'raw', rawLanguage: 'json', content: '{\n  "username": "{{username}}",\n  "password": "{{password}}"\n}' },
        headers: [{ name: 'Content-Type', value: 'application/json', enabled: true }],
      })
      request('profile', 'flows.templates.profileRequest', '{{baseUrl}}/me', 2, {
        authentication: { type: 'bearer', token: '{{nodes.login.response.body.token}}' },
      })
      display('result', '{{nodes.profile.response.body}}', 3)
      connect('start', 'login')
      connect('login', 'profile', 'success')
      connect('profile', 'result', 'success')
      break
    case 'chainedRequests':
      request('user', 'flows.templates.userRequest', '{{baseUrl}}/users/1', 1)
      request('posts', 'flows.templates.postsRequest', '{{baseUrl}}/users/{{nodes.user.response.body.id}}/posts', 2)
      display('result', '{{nodes.posts.response.body}}', 3)
      connect('start', 'user')
      connect('user', 'posts', 'success')
      connect('posts', 'result', 'success')
      break
    case 'condition':
      request('health', 'flows.templates.healthRequest', '{{baseUrl}}/health', 1)
      nodes.push({ id: 'status', kind: 'if', condition: { left: '{{nodes.health.response.status}}', operator: 'equals', right: '200' }, position: position(2) })
      nodes.push({ id: 'healthy', kind: 'log', message: t('flows.templates.healthy'), position: position(3) })
      nodes.push({ id: 'unhealthy', kind: 'log', message: t('flows.templates.unhealthy'), position: position(3, 1) })
      connect('start', 'health')
      connect('health', 'status', 'success')
      connect('health', 'status', 'failure')
      connect('status', 'healthy', 'true')
      connect('status', 'unhealthy', 'false')
      break
    case 'repeat':
      nodes.push({ id: 'initialize', kind: 'setVariables', assignments: [{ name: 'iteration', operation: 'set', value: '0' }], position: position(1) })
      nodes.push({ id: 'repeat', kind: 'while', condition: { left: '{{iteration}}', operator: 'lessThan', right: '3' }, maxIterations: 3, position: position(2) })
      request('request', 'flows.templates.healthRequest', '{{baseUrl}}/health', 3)
      nodes.push({ id: 'pause', kind: 'sleep', durationMs: 1000, position: position(4) })
      nodes.push({ id: 'increment', kind: 'setVariables', assignments: [{ name: 'iteration', operation: 'increment', by: 1 }], position: position(5) })
      nodes.push({ id: 'complete', kind: 'log', message: t('flows.templates.completed'), position: position(3, 1) })
      connect('start', 'initialize')
      connect('initialize', 'repeat')
      connect('repeat', 'request', 'loop')
      connect('request', 'pause', 'success')
      connect('pause', 'increment')
      connect('repeat', 'complete', 'done')
      break
    case 'orderForm': {
      // The inline mock keeps the example runnable without any external API.
      const server: MockServerDto = {
        id: crypto.randomUUID(),
        name: t('flows.templates.orderForm.mockName'),
        port: 3010,
        corsEnabled: true,
        routes: [{
          id: crypto.randomUUID(),
          name: t('flows.templates.orderForm.route'),
          enabled: true,
          method: 'POST',
          path: '/orders',
          defaultResponse: {
            id: crypto.randomUUID(),
            name: t('flows.templates.orderForm.response'),
            enabled: true,
            status: 201,
            headers: [{ name: 'content-type', value: 'application/json' }],
            body: '{\n  "id": "ord_1042",\n  "status": "confirmed"\n}',
            delayMs: 0,
            condition: null,
          },
          alternatives: [],
        }],
      }
      const form: FlowForm = {
        title: t('flows.templates.orderForm.formTitle'),
        description: t('flows.templates.orderForm.formDescription'),
        sections: [
          formSection('order', 'flows.templates.orderForm.orderSection', [
            formField('customer', 'flows.templates.orderForm.customer', 'text', { required: true, initialValue: 'Ada Lovelace' }),
            formField('quantity', 'flows.templates.orderForm.quantity', 'number', { required: true, initialValue: '2', min: 1, max: 99, step: 1 }),
            formField('priority', 'flows.templates.orderForm.priority', 'select', {
              required: true, initialValue: 'standard',
              options: [
                { value: 'standard', label: t('flows.templates.orderForm.standard') },
                { value: 'express', label: t('flows.templates.orderForm.express') },
              ],
            }),
            formField('giftWrap', 'flows.templates.orderForm.giftWrap', 'checkbox', { initialValue: 'false' }),
          ]),
          formSection('notes', 'flows.templates.orderForm.notesSection', [
            formField('notes', 'flows.templates.orderForm.notes', 'textarea'),
          ], true),
        ],
      }
      nodes[0] = { id: 'start', kind: 'start', form, position: { x: 0, y: 0 } }
      nodes.push({ id: 'mock', kind: 'mockStart', source: { type: 'inline', server }, position: position(1) })
      request('order', 'flows.templates.orderForm.request', '{{nodes.mock.server.url}}/orders', 2, {
        method: 'post',
        headers: [{ name: 'Content-Type', value: 'application/json', enabled: true }],
        body: { type: 'raw', rawLanguage: 'json', content: '{\n  "customer": "{{nodes.start.form.customer}}",\n  "quantity": {{nodes.start.form.quantity}},\n  "priority": "{{nodes.start.form.priority}}",\n  "giftWrap": {{nodes.start.form.giftWrap}}\n}' },
      })
      display('result', '{{nodes.order.response.body}}', 3)
      connect('start', 'mock')
      connect('mock', 'order')
      connect('order', 'result', 'success')
      break
    }
    case 'load':
      nodes.push({ id: 'scenario', kind: 'load', loadKind: 'scenario', label: t('flows.loadNode.scenario.label'), config: defaultLoadNodeConfig('scenario'), position: position(1) })
      nodes.push({ id: 'request', kind: 'load', loadKind: 'request', label: t('flows.loadNode.request.label'), config: defaultLoadNodeConfig('request'), position: position(2) })
      nodes.push({ id: 'check', kind: 'load', loadKind: 'check', label: t('flows.loadNode.check.label'), config: defaultLoadNodeConfig('check'), position: position(3) })
      connect('start', 'scenario')
      connect('scenario', 'request', 'iteration')
      connect('request', 'check', 'success')
      break
  }

  if (templateId !== 'blank') {
    nodes.push({ id: 'instructions', kind: 'note', text: t(`flows.templates.${templateId}.instructions`), width: 340, height: 180, position: { x: 0, y: -256 } })
  }
  return { id: crypto.randomUUID(), name: t(definition.nameKey), executionKind: definition.executionKind, nodes, edges, createdAtMs: now, updatedAtMs: now }
}
