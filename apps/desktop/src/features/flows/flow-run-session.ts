import { useSyncExternalStore } from 'react'
import { cancelFlow } from '../../bindings/cancel-flow'
import { releaseFlowRun } from '../../bindings/flow-forms'
import type { FormAnswers } from '../../bindings/flow-forms'
import type { FlowNodeState } from './flows.types'
import type { NodeRunStatus } from './use-flow-run'
import type { RunLogEntry } from './run-log'

interface SessionState {
  snapshotNodeIds: Record<string, string>
  viewMode: 'diagram' | 'panels'
  statuses: Record<string, NodeRunStatus>
  traversedEdges: ReadonlySet<string>
  logEntries: RunLogEntry[]
  runStartedAtMs: number | null
  flowExecutionId: string | null
  isRunning: boolean
  runNodes: FlowNodeState[]
  formDrafts: Record<string, FormAnswers>
}
type Update<T> = T | ((current: T) => T)

class FlowRunSession {
  state: SessionState = { snapshotNodeIds: {}, viewMode: 'diagram', statuses: {}, traversedEdges: new Set(), logEntries: [], runStartedAtMs: null, flowExecutionId: null, isRunning: false, runNodes: [], formDrafts: {} }
  listeners = new Set<() => void>()
  disposed = false
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.state
  private update<K extends keyof SessionState>(key: K, value: Update<SessionState[K]>) {
    this.state = { ...this.state, [key]: typeof value === 'function' ? (value as (v: SessionState[K]) => SessionState[K])(this.state[key]) : value }
    if (this.disposed && !this.state.isRunning && this.state.flowExecutionId) void releaseFlowRun(this.state.flowExecutionId).catch(() => undefined)
    this.listeners.forEach((notify) => notify())
  }
  setStatuses = (v: Update<SessionState['statuses']>) => this.update('statuses', v)
  setSnapshotNodeIds = (v: Update<SessionState['snapshotNodeIds']>) => this.update('snapshotNodeIds', v)
  setViewMode = (v: Update<SessionState['viewMode']>) => this.update('viewMode', v)
  setTraversedEdges = (v: Update<SessionState['traversedEdges']>) => this.update('traversedEdges', v)
  setLogEntries = (v: Update<SessionState['logEntries']>) => this.update('logEntries', v)
  setRunStartedAtMs = (v: Update<number | null>) => this.update('runStartedAtMs', v)
  setFlowExecutionId = (v: Update<string | null>) => this.update('flowExecutionId', v)
  setIsRunning = (v: Update<boolean>) => this.update('isRunning', v)
  setRunNodes = (v: Update<FlowNodeState[]>) => this.update('runNodes', v)
  setFormDrafts = (v: Update<SessionState['formDrafts']>) => this.update('formDrafts', v)
  close() {
    this.disposed = true
    if (this.state.flowExecutionId) {
      if (this.state.isRunning) void cancelFlow(this.state.flowExecutionId).catch(() => undefined)
      else void releaseFlowRun(this.state.flowExecutionId).catch(() => undefined)
    }
    this.state = { ...this.state, formDrafts: {} }
    this.listeners.clear()
  }
}

const sessions = new Map<string, { rootPath: string; flowId: string; session: FlowRunSession }>()

export function useFlowRunSession(rootPath: string, flowId: string) {
  const key = JSON.stringify([rootPath, flowId])
  let entry = sessions.get(key)
  if (!entry) { entry = { rootPath, flowId, session: new FlowRunSession() }; sessions.set(key, entry) }
  const { session } = entry
  const state = useSyncExternalStore(session.subscribe, session.snapshot)
  return { state, session }
}

/** The workbench owns session lifetime; switching the active tab does not close it. */
export function releaseClosedFlowSessions(rootPath: string, openFlowIds: readonly string[]) {
  const open = new Set(openFlowIds)
  for (const [key, entry] of sessions) {
    if (entry.rootPath === rootPath && !open.has(entry.flowId)) { entry.session.close(); sessions.delete(key) }
  }
}
