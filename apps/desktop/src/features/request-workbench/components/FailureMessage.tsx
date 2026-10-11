import { useLanguage } from '../../../shared/i18n/use-language'

interface FailureMessageProps {
  summary: string
  /** Mensagem técnica do backend, quando `summary` vem de uma causa reconhecida e não a inclui. */
  detail: string | null
  className?: string
}

/** Falha descrita no idioma da interface, com o detalhe técnico selecionável logo abaixo (ADR 0044). */
export function FailureMessage({ summary, detail, className }: FailureMessageProps) {
  const { t } = useLanguage()
  return (
    <div className={className ? `rw-failure ${className}` : 'rw-failure'}>
      <p className="rw-status-message">{summary}</p>
      {detail !== null && (
        <p className="rw-failure-detail">
          {t('common.technicalDetails')} <code>{detail}</code>
        </p>
      )}
    </div>
  )
}
