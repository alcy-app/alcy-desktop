import type { ComparedOutcomeDto, ResponseComparisonDto } from '../../../bindings/compare-request-sends'
import type { HistoryOutcomeSummary } from '../../../bindings/list-history'
import type { RequestSendDto } from '../../../bindings/list-request-sends'
import { useLanguage } from '../../../shared/i18n/use-language'
import { DiffHunks } from '../../../shared/ui/DiffHunks'
import { CloseIcon } from '../../../shared/ui/icons'
import { IconButton } from '../../../shared/ui/IconButton'
import { InlineAlert } from '../../../shared/ui/InlineAlert'
import { statusTone } from '../response-summary'
import { useSendComparison } from '../use-send-history'

type Outcome = HistoryOutcomeSummary | ComparedOutcomeDto
type Translate = ReturnType<typeof useLanguage>['t']

function failureLabel(t: Translate, kind: 'network' | 'timeout'): string {
  return kind === 'timeout' ? t('response.errorTimeoutLabel') : t('response.errorNetworkLabel')
}

/** Status de um envio em texto colorido (lista do histórico). */
export function OutcomeText({ outcome }: { outcome: Outcome }) {
  const { t } = useLanguage()
  if (outcome.type === 'failed') {
    return <span className="rw-history-status rw-history-status--error">{failureLabel(t, outcome.kind)}</span>
  }
  return <span className={`rw-history-status rw-history-status--${statusTone(outcome.statusCode)}`}>{outcome.statusCode}</span>
}

function OutcomePill({ outcome }: { outcome: Outcome }) {
  const { t } = useLanguage()
  if (outcome.type === 'failed') {
    return <span className="rw-response-status rw-response-status--error">{failureLabel(t, outcome.kind)}</span>
  }
  return <span className={`rw-response-status rw-response-status--${statusTone(outcome.statusCode)}`}>HTTP {outcome.statusCode}</span>
}

interface ResponseComparisonViewProps {
  rootPath: string
  /** Envio mais antigo, lado "−". */
  base: RequestSendDto
  /** Envio mais novo, lado "+". */
  target: RequestSendDto
  onClose: () => void
  formatTime: (send: RequestSendDto) => string
}

/** Diferenças entre a resposta de dois envios, no estilo git, calculadas no backend. */
export function ResponseComparisonView({ rootPath, base, target, onClose, formatTime }: ResponseComparisonViewProps) {
  const { t } = useLanguage()
  const comparison = useSendComparison(rootPath, base.id, target.id)

  return (
    <section className="rw-compare" aria-label={t('responseHistory.compareAria')}>
      <header className="rw-compare-header">
        <span className="rw-compare-side rw-compare-side--base">− {formatTime(base)}</span>
        <OutcomePill outcome={base.outcome} />
        <span aria-hidden="true">→</span>
        <span className="rw-compare-side rw-compare-side--target">+ {formatTime(target)}</span>
        <OutcomePill outcome={target.outcome} />
        <div className="rw-compare-header-actions">
          <IconButton icon={<CloseIcon size={14} />} label={t('responseHistory.closeCompare')} onClick={onClose} />
        </div>
      </header>
      {comparison.status === 'loading' && <p className="rw-status-message">{t('responseHistory.comparingProgress')}</p>}
      {comparison.status === 'error' && (
        <InlineAlert>{comparison.notStored ? t('responseHistory.compareNotStored') : t('responseHistory.compareError')}</InlineAlert>
      )}
      {comparison.status === 'ready' && <ComparisonBody comparison={comparison.comparison} />}
    </section>
  )
}

function ComparisonBody({ comparison }: { comparison: ResponseComparisonDto }) {
  const { t } = useLanguage()
  const { body } = comparison
  const bothResponded = comparison.base.type === 'response' && comparison.target.type === 'response'

  // Sem mensagem de "iguais/diferentes": o diff (e o status no cabeçalho) já
  // mostram isso. Os textos abaixo só explicam quando não há linhas a exibir.
  return (
    <>
      {!bothResponded && <p className="rw-status-message">{t('responseHistory.noBody')}</p>}
      {bothResponded && body.binary && (
        <p className="rw-status-message">{t(comparison.identical ? 'responseHistory.noBodyDifferences' : 'responseHistory.binary')}</p>
      )}
      {bothResponded && body.tooLarge && <p className="rw-status-message">{t('responseHistory.tooLarge')}</p>}
      {bothResponded && !body.binary && !body.tooLarge && body.hunks.length === 0 && (
        <p className="rw-status-message">{t('responseHistory.noBodyDifferences')}</p>
      )}
      {body.hunks.length > 0 && (
        <div className="rw-compare-body" tabIndex={0} role="region" aria-label={t('responseHistory.diffAria')}>
          <DiffHunks hunks={body.hunks.map((hunk) => ({ oldStart: hunk.baseStart, newStart: hunk.targetStart, lines: hunk.lines }))} />
        </div>
      )}
      {body.truncated && <p className="rw-status-message">{t('responseHistory.truncated')}</p>}
    </>
  )
}
