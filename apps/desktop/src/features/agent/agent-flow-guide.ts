/**
 * get_flow_guide: how to build flows, read on demand so the system prompt
 * stays short (spec 0139). Examples are add_flow_node arguments.
 */

interface KindGuide {
  use: string
  fields: string
  outputs: string
  example: Record<string, unknown>
}

export const FLOW_NODE_GUIDE = {
  inlineRequest: { use: 'Send an HTTP, GraphQL or gRPC request stored in the flow.', fields: 'name, protocol (rest default), and the update_request fields: method, url, headers, body, query, variables, authentication, preRequestScript, postResponseScript.', outputs: "'success' (status < 400) and 'failure'.", example: { kind: 'inlineRequest', name: 'Login', method: 'post', url: '{{baseUrl}}/login', body: { type: 'raw', language: 'json', content: '{"user":"{{user}}"}' }, after: 'start' } },
  request: { use: 'Run a request saved in a collection.', fields: 'requestId (from search_collections).', outputs: "'success' and 'failure'.", example: { kind: 'request', requestId: '<id from search_collections>', after: 'start' } },
  if: { use: 'Choose a branch by comparing two values.', fields: 'left, operator (equals, notEquals, greaterThan, lessThan), right. Values may use {{references}}.', outputs: "'true' and 'false'.", example: { kind: 'if', left: '{{nodes.login.response.status}}', operator: 'equals', right: '200', after: 'login' } },
  while: { use: 'Repeat steps while a condition holds.', fields: 'left, operator, right, maxIterations (default 100).', outputs: "'loop' leads to the steps to repeat (they must not connect outside the loop); 'done' continues afterwards.", example: { kind: 'while', left: '{{page}}', operator: 'lessThan', right: '5', after: 'start' } },
  setVariables: { use: 'Set flow variables, read later as {{name}}.', fields: "assignments: [{name, operation: 'set', value}] or [{name, operation: 'increment', by}].", outputs: 'one.', example: { kind: 'setVariables', assignments: [{ name: 'page', operation: 'set', value: '1' }], after: 'start' } },
  log: { use: 'Write a message to the run log.', fields: 'message (may use {{references}}).', outputs: 'one.', example: { kind: 'log', message: 'Token: {{nodes.login.response.body.token}}', after: 'login', output: 'success' } },
  display: { use: 'Show a value in the node after the run.', fields: 'template (may use {{references}}).', outputs: 'one.', example: { kind: 'display', template: '{{nodes.profile.response.body}}', after: 'profile' } },
  sleep: { use: 'Wait before the next step.', fields: 'durationMs (max 600000).', outputs: 'one.', example: { kind: 'sleep', durationMs: 1000, after: 'login' } },
  humanAction: { use: 'Pause until the user fills a form.', fields: 'form: {title, description, sections: [{id, title, fields: [{id, label, kind: text|textarea|number|select|radio|checkbox|result, required, initialValue, options}]}]}.', outputs: 'one. Answers are {{nodes.<id>.form.<fieldId>}}.', example: { kind: 'humanAction', form: { title: 'Confirm', description: '', sections: [{ id: 'main', title: 'Order', fields: [{ id: 'quantity', label: 'Quantity', kind: 'number', required: true }] }] }, after: 'start' } },
  note: { use: 'A comment on the canvas; never runs or connects.', fields: 'text.', outputs: 'none.', example: { kind: 'note', text: 'Logs in, then reads the profile.' } },
  break: { use: 'Leave the current While loop.', fields: 'none.', outputs: 'none.', example: { kind: 'break', after: 'check', output: 'true' } },
  continue: { use: 'Skip to the next iteration of the current While loop.', fields: 'none.', outputs: 'none.', example: { kind: 'continue', after: 'check', output: 'false' } },
  mockStart: { use: 'Start a local mock server for this run.', fields: 'serverId (from list_mock_servers) or source {type: inline, server}.', outputs: 'one. Its address is {{nodes.<id>.server.url}}.', example: { kind: 'mockStart', serverId: '<id from list_mock_servers>', after: 'start' } },
  mockStop: { use: 'Stop the mock started by a mockStart node.', fields: 'startNodeId.', outputs: 'one.', example: { kind: 'mockStop', startNodeId: 'mock', after: 'check' } },
  mockWaitRequest: { use: 'Wait for a call to a mock route.', fields: 'startNodeId, routeId (from get_mock_server), timeoutMs.', outputs: "'true' when called, 'false' on timeout. The call is {{nodes.<id>.request.body.<path>}}.", example: { kind: 'mockWaitRequest', startNodeId: 'mock', routeId: '<route id>', after: 'mock' } },
  mockSetResponse: { use: 'Force a mock route to answer with one of its responses.', fields: 'startNodeId, routeId, responseId (null restores the rules).', outputs: 'one.', example: { kind: 'mockSetResponse', startNodeId: 'mock', routeId: '<route id>', responseId: '<response id>', after: 'mock' } },
  mockAssertCalls: { use: 'Check how many calls a mock route received.', fields: 'startNodeId, routeId, operator (equals, atLeast, atMost), count.', outputs: "'true' and 'false'.", example: { kind: 'mockAssertCalls', startNodeId: 'mock', routeId: '<route id>', operator: 'equals', count: 1, after: 'order', output: 'success' } },
  block: { use: 'Legacy label with no behavior; prefer note.', fields: 'label.', outputs: 'one.', example: { kind: 'block', label: 'Step', after: 'start' } },
  load: { use: 'Load-test block, only in load flows.', fields: 'loadKind, config (JSON text).', outputs: 'depends on loadKind (scenario: iteration/done).', example: { kind: 'load', loadKind: 'request', after: 'scenario', output: 'iteration' } },
} satisfies Record<string, KindGuide>

const OVERVIEW = [
  "A flow runs from the node 'start' along its connections. Build it in small steps:",
  '1. create_flow (template or requestIds when one fits) returns flowId.',
  "2. add_flow_node for each step, with after = the previous node id; ids, positions and connections are filled in. Branching nodes take output (request: success/failure, if: true/false, while: loop/done).",
  '3. Later steps read earlier results with {{nodes.<id>.response.body.<path>}}; get_flow_references lists them for a node.',
  '4. check_flow, fix what it reports, then run_flow and get_flow_run.',
  'connect_flow_nodes / disconnect_flow_nodes change connections; update_flow edits several nodes at once; organize_flow tidies the canvas.',
].join('\n')

const REFERENCES = [
  'Values from nodes that ran earlier on the same path:',
  '{{nodes.<id>.response.status}} · {{nodes.<id>.response.body}} · {{nodes.<id>.response.body.data.items.0.id}} · {{nodes.<id>.response.headers.<name>}} (request nodes)',
  '{{nodes.<id>.form.<fieldId>}} (start with form, humanAction)',
  '{{nodes.<id>.server.url}} (mockStart) · {{nodes.<id>.request.body.<path>}}, .query.<name>, .headers.<name>, .params.<name> (mockWaitRequest)',
  '{{name}} reads an environment, collection or Set variables value.',
  'A node can only use nodes connected before it; check_flow reports the rest.',
].join('\n')

export type FlowGuideTopic = 'overview' | 'references' | keyof typeof FLOW_NODE_GUIDE

export const FLOW_GUIDE_TOPICS = ['overview', 'references', ...Object.keys(FLOW_NODE_GUIDE)] as FlowGuideTopic[]

export function flowGuide(topic: unknown = 'overview'): unknown {
  if (topic === 'overview' || topic === undefined) return { overview: OVERVIEW, nodeKinds: Object.fromEntries(Object.entries(FLOW_NODE_GUIDE).map(([kind, guide]) => [kind, guide.use])) }
  if (topic === 'references') return { references: REFERENCES }
  const guide = FLOW_NODE_GUIDE[topic as keyof typeof FLOW_NODE_GUIDE]
  if (!guide) throw new Error(`Unknown topic '${String(topic)}'. Topics: ${FLOW_GUIDE_TOPICS.join(', ')}.`)
  return { kind: topic, ...guide }
}
