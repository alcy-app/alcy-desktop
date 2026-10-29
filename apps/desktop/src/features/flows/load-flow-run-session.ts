import { useSyncExternalStore } from 'react'
import { cancelLoadFlow } from '../../bindings/cancel-load-flow'
import type { LoadRunDetailDto } from '../../bindings/get-load-run-history'

export interface LoadRunProgressState {
  activeVus: number
  plannedVus: number
  completedIterations: number
  droppedIterations: number
  requests: number
  failedRequests: number
  checksPassed: number
  checksFailed: number
  elapsedMs: number
}

export const INITIAL_LOAD_PROGRESS: LoadRunProgressState = {
  activeVus: 0, plannedVus: 0, completedIterations: 0, droppedIterations: 0,
  requests: 0, failedRequests: 0, checksPassed: 0, checksFailed: 0, elapsedMs: 0,
}

interface State {
  runId: string | null
  isRunning: boolean
  progress: LoadRunProgressState
  detail: LoadRunDetailDto | null
  error: string | null
}

class LoadFlowRunSession {
  state: State = { runId: null, isRunning: false, progress: INITIAL_LOAD_PROGRESS, detail: null, error: null }
  disposed = false
  private listeners = new Set<() => void>()
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.state
  update = (patch: Partial<State>) => {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener())
  }
  setDetail = (detail: LoadRunDetailDto | null) => this.update({ detail })
  cancel = () => { if (this.state.runId && this.state.isRunning) void cancelLoadFlow(this.state.runId) }
  close() { this.cancel(); this.disposed = true; this.listeners.clear() }
}

const sessions = new Map<string, { rootPath: string; flowId: string; session: LoadFlowRunSession }>()
export function useLoadFlowRunSession(rootPath: string, flowId: string) {
  const key = JSON.stringify([rootPath, flowId])
  let entry = sessions.get(key)
  if (!entry) { entry = { rootPath, flowId, session: new LoadFlowRunSession() }; sessions.set(key, entry) }
  const { session } = entry
  const state = useSyncExternalStore(session.subscribe, session.snapshot)
  return { state, session }
}

export function getLoadFlowRunState(rootPath: string, flowId: string) {
  return sessions.get(JSON.stringify([rootPath, flowId]))?.session.state
}

export function releaseClosedLoadFlowSessions(rootPath: string, openFlowIds: readonly string[]) {
  for (const [key, entry] of sessions) {
    if (entry.rootPath === rootPath && !openFlowIds.includes(entry.flowId)) { entry.session.close(); sessions.delete(key) }
  }
}
