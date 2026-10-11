import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import type { KeyboardEvent } from 'react'
import type { ConnectionInfo } from '../../../bindings/execute-graphql-request'
import { useLanguage } from '../../../shared/i18n/use-language'
import { AlertIcon, GlobeIcon } from '../../../shared/ui/icons'

const CARD_GAP_PX = 6
const CARD_WIDTH_PX = 280
const VIEWPORT_MARGIN_PX = 8

interface CardPosition {
  left: number
  top: number
}

/**
 * Globo no resumo da resposta: ao passar o mouse ou focar, mostra os dados da
 * conexão. Fica em tom de alerta quando a requisição saiu com a verificação
 * de certificado desligada (ADR 0058). O cartão vai num portal em
 * `document.body`, como o de variáveis, para não ser cortado pelo painel.
 */
export function ResponseNetworkBadge({ connection }: { connection: ConnectionInfo }) {
  const { t } = useLanguage()
  const cardId = useId()
  const [position, setPosition] = useState<CardPosition | null>(null)
  const unverified = connection.certificateVerificationDisabled

  const open = (target: HTMLElement) => {
    const rect = target.getBoundingClientRect()
    const left = Math.min(rect.left, window.innerWidth - CARD_WIDTH_PX - VIEWPORT_MARGIN_PX)
    setPosition({ left: Math.max(left, VIEWPORT_MARGIN_PX), top: rect.bottom + CARD_GAP_PX })
  }
  const close = () => setPosition(null)
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') close()
  }

  return (
    <>
      <button
        type="button"
        className={`rw-network-badge${unverified ? ' rw-network-badge--warning' : ''}`}
        aria-label={unverified ? `${t('response.networkBadgeAria')}: ${t('response.networkCertificateUnverified')}` : t('response.networkBadgeAria')}
        aria-describedby={position ? cardId : undefined}
        onMouseEnter={(event) => open(event.currentTarget)}
        onMouseLeave={close}
        onFocus={(event) => open(event.currentTarget)}
        onBlur={close}
        onKeyDown={handleKeyDown}
      >
        <GlobeIcon size={13} />
      </button>
      {position &&
        createPortal(
          <div id={cardId} role="tooltip" className="rw-network-card" style={{ left: position.left, top: position.top }}>
            {unverified && (
              <p className="rw-network-card-warning">
                <AlertIcon size={13} />
                <span>
                  <strong>{t('response.networkCertificateUnverified')}</strong>
                  <br />
                  {t('response.networkCertificateUnverifiedHint')}
                </span>
              </p>
            )}
            <dl className="rw-network-card-list">
              <dt>{t('response.networkRemoteAddressLabel')}</dt>
              <dd>{connection.remoteAddress ?? t('response.networkUnknown')}</dd>
              <dt>{t('response.networkHttpVersionLabel')}</dt>
              <dd>{connection.httpVersion}</dd>
              <dt>{t('response.networkTlsLabel')}</dt>
              <dd>{connection.tlsCertificatePresent ? t('response.networkTlsPresent') : t('response.networkTlsAbsent')}</dd>
              {connection.tlsCertificatePresent && (
                <>
                  <dt>{t('response.networkVerificationLabel')}</dt>
                  <dd>{unverified ? t('response.networkVerificationOff') : t('response.networkVerificationOn')}</dd>
                </>
              )}
            </dl>
          </div>,
          document.body,
        )}
    </>
  )
}
