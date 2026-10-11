import { DisplayNode, LogNode, SetVariablesNode, SleepNode } from './ActionNode'
import { BreakNode, ContinueNode } from './LoopControlNode'
import { BlockNode } from './BlockNode'
import { FlowEdge } from './FlowEdge'
import { IfNode } from './IfNode'
import { InlineRequestNode } from './InlineRequestNode'
import { MockAssertCallsNode, MockSetResponseNode, MockStartNode, MockStopNode, MockWaitRequestNode } from './MockNodes'
import { NoteNode } from './NoteNode'
import { RequestNode } from './RequestNode'
import { StartNode } from './StartNode'
import { WhileNode } from './WhileNode'

export const nodeTypes = {
  start: StartNode,
  block: BlockNode,
  request: RequestNode,
  if: IfNode,
  note: NoteNode,
  log: LogNode,
  display: DisplayNode,
  sleep: SleepNode,
  setVariables: SetVariablesNode,
  while: WhileNode,
  break: BreakNode,
  continue: ContinueNode,
  inlineRequest: InlineRequestNode,
  mockStart: MockStartNode,
  mockStop: MockStopNode,
  mockWaitRequest: MockWaitRequestNode,
  mockSetResponse: MockSetResponseNode,
  mockAssertCalls: MockAssertCallsNode,
}
export const edgeTypes = { default: FlowEdge }
