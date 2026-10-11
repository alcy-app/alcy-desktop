import { useEffect, useMemo, useState } from 'react'
import { evaluateValueMonitors } from '../../bindings/evaluate-value-monitors'
import type { ValueFindingDto } from '../../bindings/evaluate-value-monitors'
import type { ValueMonitorDto } from '../../bindings/list-value-monitors'
import { WORKER_FORMAT_THRESHOLD_BYTES, monitorCandidatesOffMainThread } from './format-off-main-thread'
import type { JsonPathSegment } from './json-value-index'
import { lastFieldKey, monitorCandidates } from './value-monitor-candidates'
import type { MonitorCandidate } from './value-monitor-candidates'

/** Espera após a última mudança (texto ou monitores) antes de avaliar — editar uma regra não dispara um IPC por tecla. */
const EVALUATE_DEBOUNCE_MS = 200

/** Resultado de um monitor sobre um valor; `failedRuleIds` vazio = aprovado. */
export interface MonitorResult {
  monitorId: string
  field: string
  failedRuleIds: string[]
}

/** Um valor monitorado da resposta, com a faixa no texto formatado. */
export interface MonitorHighlight {
  from: number
  to: number
  path: JsonPathSegment[]
  /** Reprovado por pelo menos uma regra de algum monitor. */
  failed: boolean
  results: MonitorResult[]
}

export type MonitorFindings =
  | { status: 'notJson' | 'partial' | 'evaluating' | 'error' }
  | { status: 'ready'; highlights: MonitorHighlight[]; truncated: boolean }

interface Evaluation {
  text: string
  monitors: ValueMonitorDto[]
  outcome: { ok: true; highlights: MonitorHighlight[]; truncated: boolean } | { ok: false }
}

/** Agrupa os resultados por valor, na ordem do documento. */
export function highlightsFrom(candidates: MonitorCandidate[], findings: ValueFindingDto[]): MonitorHighlight[] {
  const byIndex = new Map<number, MonitorResult[]>()
  for (const finding of findings) {
    const results = byIndex.get(finding.valueIndex) ?? []
    results.push({ monitorId: finding.monitorId, field: finding.field, failedRuleIds: finding.failedRuleIds })
    byIndex.set(finding.valueIndex, results)
  }
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([index, results]) => {
      const candidate = candidates[index]
      if (!candidate) return []
      return [
        {
          from: candidate.from,
          to: candidate.to,
          path: candidate.path,
          failed: results.some((result) => result.failedRuleIds.length > 0),
          results,
        },
      ]
    })
}

async function evaluate(text: string, monitors: ValueMonitorDto[]): Promise<Evaluation['outcome']> {
  const lastKeys = [...new Set(monitors.flatMap((monitor) => monitor.fields.map(lastFieldKey)))]
  const { candidates, truncated } =
    text.length >= WORKER_FORMAT_THRESHOLD_BYTES
      ? await monitorCandidatesOffMainThread(text, lastKeys)
      : monitorCandidates(text, lastKeys)
  if (candidates.length === 0) return { ok: true, highlights: [], truncated }

  const result = await evaluateValueMonitors(
    monitors,
    candidates.map((candidate) => ({ path: candidate.path, literal: candidate.literal })),
  )
  if (!result.ok) return { ok: false }
  return { ok: true, highlights: highlightsFrom(candidates, result.value), truncated }
}

/**
 * Avalia os monitores habilitados sobre o texto formatado da resposta. Sem
 * monitores (`null` ou nenhum habilitado) devolve `null`. Enquanto uma
 * nova avaliação corre para o mesmo texto, os destaques anteriores ficam na
 * tela — editar uma regra não faz o corpo piscar.
 */
export function useValueMonitorFindings(
  text: string,
  isJson: boolean,
  partial: boolean,
  monitors: ValueMonitorDto[] | null,
): MonitorFindings | null {
  const active = useMemo(() => monitors?.filter((monitor) => monitor.enabled && monitor.fields.length > 0) ?? [], [monitors])
  const runnable = active.length > 0 && isJson && !partial
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null)

  useEffect(() => {
    if (!runnable) return
    let cancelled = false
    const timeout = window.setTimeout(() => {
      void evaluate(text, active)
        .catch((): Evaluation['outcome'] => ({ ok: false }))
        .then((outcome) => {
          if (!cancelled) setEvaluation({ text, monitors: active, outcome })
        })
    }, EVALUATE_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [runnable, text, active])

  if (active.length === 0) return null
  if (!isJson) return { status: 'notJson' }
  if (partial) return { status: 'partial' }
  if (!evaluation || evaluation.text !== text) return { status: 'evaluating' }
  if (!evaluation.outcome.ok) return evaluation.monitors === active ? { status: 'error' } : { status: 'evaluating' }
  return { status: 'ready', highlights: evaluation.outcome.highlights, truncated: evaluation.outcome.truncated }
}
