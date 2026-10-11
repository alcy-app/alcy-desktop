import type { TranslationKey, TranslationParams } from '../../shared/i18n/translations'
import type { NodeRunStatus } from './use-flow-run'

export type RunChipTone = 'neutral' | 'accent' | 'success' | 'warning' | 'error'

/** Chip de status no cabeçalho do cartão (spec 0087). */
export interface RunStatusChip {
  tone: RunChipTone
  label: string
  /** Texto secundário ao lado do rótulo (ex.: duração da requisição). */
  detail?: string
}

type Translate = (key: TranslationKey, params?: TranslationParams) => string

/** Um único mapeamento de `NodeRunStatus` para o chip, compartilhado por
 * todos os tipos de node — cada status só é produzido pelos tipos que fazem
 * sentido (`branched` pelo `if`, `looping` pelo `while` etc.). A mensagem de
 * falha não entra aqui: vai para a faixa de erro do cartão. */
export function describeRunStatus(runStatus: NodeRunStatus, t: Translate): RunStatusChip | null {
  switch (runStatus.status) {
    case 'idle':
      return null
    case 'running':
      // Sem spinner: uma animação de `transform` dentro do viewport faz o
      // WebKitGTK compor o canvas inteiro numa camada rasterizada na escala
      // 1, e todos os nodes ficam borrados no zoom até o canvas remontar.
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

/** Classes de estado do cartão durante/depois de um run: em execução
 * (`running` ou uma iteração de `while`), pulado (esmaecido), com falha e
 * rastro (`visited`, a varredura de luz). */
export function runStateClass(runStatus: NodeRunStatus, visited: boolean | undefined): string {
  if (runStatus.status === 'running' || runStatus.status === 'looping') return 'flow-node--active'
  if (runStatus.status === 'skipped') return 'flow-node--skipped'
  const classes: string[] = []
  if (runStatus.status === 'failed') classes.push('flow-node--failed')
  if (visited) classes.push('flow-node--visited')
  return classes.join(' ')
}
