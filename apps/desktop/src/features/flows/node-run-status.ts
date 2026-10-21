import type { TranslationKey, TranslationParams } from '../../shared/i18n/translations'
import type { NodeRunStatus } from './use-flow-run'

export type RunChipTone = 'neutral' | 'accent' | 'success' | 'warning' | 'error'

/** Status chip in the node card header (spec 0087). */
export interface RunStatusChip {
  tone: RunChipTone
  label: string
  /** Secondary text beside the label, such as request duration. */
  detail?: string
}

type Translate = (key: TranslationKey, params?: TranslationParams) => string

/** Shared status-to-chip mapping. Failure details appear in the card error strip. */
export function describeRunStatus(runStatus: NodeRunStatus, t: Translate): RunStatusChip | null {
  switch (runStatus.status) {
    case 'waitingForHuman':
      return { tone: 'warning', label: t('flows.forms.waiting') }
    case 'idle':
      return null
    case 'running':
      // A transform-animated spinner makes WebKitGTK rasterize the whole viewport at scale 1, blurring zoomed nodes until remount.
      return { tone: 'accent', label: t('flows.canvas.nodeRunningLabel') }
    case 'success':
      return {
        tone: runStatus.statusCode >= 400 ? 'error' : 'success',
        label: String(runStatus.statusCode),
        detail: `${runStatus.durationMs} ms`,
      }
    case 'branched':
      return runStatus.result
        ? { tone: 'success', label: t('flows.canvas.ifTrueLabel') }
        : { tone: 'neutral', label: t('flows.canvas.ifFalseLabel') }
    case 'failed':
      return { tone: 'error', label: t('flows.canvas.nodeFailedLabel') }
    case 'completed':
      return { tone: 'success', label: t('flows.canvas.nodeCompletedLabel') }
    case 'looping':
      return { tone: 'accent', label: t('flows.canvas.whileIterationLabel', { iteration: runStatus.iteration }) }
    case 'loopFinished':
      return { tone: 'success', label: t('flows.canvas.whileFinishedLabel', { iterations: runStatus.iterations }) }
    case 'cancelled':
      return { tone: 'warning', label: t('flows.canvas.nodeCancelledLabel') }
    case 'skipped':
      if (runStatus.reason === 'cancelled') return { tone: 'warning', label: t('flows.canvas.nodeCancelledLabel') }
      if (runStatus.reason === 'branchNotTaken') return { tone: 'neutral', label: t('flows.canvas.nodeBranchNotTakenLabel') }
      if (runStatus.reason === 'loopInterrupted') return { tone: 'neutral', label: t('flows.canvas.nodeLoopInterruptedLabel') }
      return { tone: 'neutral', label: t('flows.canvas.nodeSkippedLabel') }
  }
}

/** Card classes for active execution, skipped nodes, failures and the visited trail. */
export function runStateClass(runStatus: NodeRunStatus, visited: boolean | undefined): string {
  if (runStatus.status === 'running' || runStatus.status === 'looping') return 'flow-node--active'
  if (runStatus.status === 'skipped') return 'flow-node--skipped'
  const classes: string[] = []
  if (runStatus.status === 'failed') classes.push('flow-node--failed')
  if (visited) classes.push('flow-node--visited')
  return classes.join(' ')
}
