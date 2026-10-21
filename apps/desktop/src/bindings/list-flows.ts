import { invoke } from '@tauri-apps/api/core'
import type { FlowForm, FlowPresentation } from './flow-forms'
import type { SavedRequestDto } from './list-collections'
import type { MockServerDto } from './mock-servers'

export type ComparisonOperatorDto = 'equals' | 'notEquals' | 'greaterThan' | 'lessThan'

export interface ConditionDto {
  left: string
  operator: ComparisonOperatorDto
  right: string
}

export type VariableAssignmentDto = { name: string } & (
  | { operation: 'set'; value: string }
  | { operation: 'increment'; by: number }
)

export type FlowExecutionKindDto = 'standard' | 'load'

/** Load-only declarative blocks. Native code preserves serialized configuration
 * without expanding the canvas contract for each executor. */
export type LoadNodeKindDto =
  | 'scenario'
  | 'request'
  | 'script'
  | 'repeat'
  | 'forEach'
  | 'oncePerVu'
  | 'timeBox'
  | 'select'
  | 'group'
  | 'timer'
  | 'dataset'
  | 'configureSession'
  | 'extract'
  | 'check'
  | 'metric'
  | 'threshold'

/** A saved workspace mock or full inline mock started by mockStart (spec 0121). */
export type MockServerSourceDto = { type: 'saved'; serverId: string } | { type: 'inline'; server: MockServerDto }

export type MockCallCountOperatorDto = 'equals' | 'atLeast' | 'atMost'

export type FlowNodeKindDto =
  | { kind: 'start'; form?: FlowForm | null }
  | { kind: 'humanAction'; form: FlowForm }
  | { kind: 'block'; label: string }
  | { kind: 'request'; requestId: string }
  | { kind: 'if'; condition: ConditionDto }
  | { kind: 'note'; text: string; width: number; height: number }
  | { kind: 'log'; message: string }
  | { kind: 'display'; template: string }
  | { kind: 'sleep'; durationMs: number }
  | { kind: 'setVariables'; assignments: VariableAssignmentDto[] }
  | { kind: 'while'; condition: ConditionDto; maxIterations: number }
  | { kind: 'break' }
  | { kind: 'continue' }
  | { kind: 'load'; loadKind: LoadNodeKindDto; label: string; config: string }
  /** Inline request, using the collection request DTO. */
  | { kind: 'inlineRequest'; request: SavedRequestDto }
  /** Mock blocks reference the mockStart node that started their mock (spec 0121). */
  | { kind: 'mockStart'; source: MockServerSourceDto }
  | { kind: 'mockStop'; startNodeId: string }
  | { kind: 'mockWaitRequest'; startNodeId: string; routeId: string; timeoutMs: number }
  | { kind: 'mockSetResponse'; startNodeId: string; routeId: string; responseId: string | null }
  | { kind: 'mockAssertCalls'; startNodeId: string; routeId: string; operator: MockCallCountOperatorDto; count: number }

export type FlowNodeDto = FlowNodeKindDto & {
  id: string
  x: number
  y: number
}

export interface FlowEdgeDto {
  id: string
  sourceNodeId: string
  targetNodeId: string
  /** Absent for single-output nodes; true/false or success/failure for branches. */
  sourceHandle?: string | null
}

export interface FlowDto {
  presentation?: FlowPresentation
  id: string
  name: string
  executionKind: FlowExecutionKindDto
  nodes: FlowNodeDto[]
  edges: FlowEdgeDto[]
  createdAtMs: number
  updatedAtMs: number
}

export interface FlowFolderDto {
  id: string
  name: string
  flowIds: string[]
}

export interface FlowsSnapshotDto {
  flows: FlowDto[]
  folders: FlowFolderDto[]
}

export type FlowsError = { kind: 'invalid'; message: string } | { kind: 'storage'; message: string }

export type ListFlowsResult = { ok: true; value: FlowsSnapshotDto } | { ok: false; error: FlowsError }

export async function listFlows(rootPath: string): Promise<ListFlowsResult> {
  try {
    const value = await invoke<FlowsSnapshotDto>('list_flows', { input: { rootPath } })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as FlowsError }
  }
}
