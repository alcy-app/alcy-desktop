import type { ConnectionInfo } from '../../../bindings/execute-graphql-request'
import { useLanguage } from '../../../shared/i18n/use-language'

interface ResponseNetworkInfoProps {
  connection: ConnectionInfo
  waitingMs: number
  durationMs: number
  finalUrl: string | null
}

/** `download` é derivado (não vem do backend): tempo total menos o TTFB.
 * Nunca negativo na prática (`waitingMs` é medido antes de `durationMs`
 * terminar de contar), mas `Math.max` protege contra arredondamento. */
export function ResponseNetworkInfo({ connection, waitingMs, durationMs, finalUrl }: ResponseNetworkInfoProps) {
  const { t } = useLanguage()
  const downloadMs = Math.max(0, durationMs - waitingMs)

  return (
    <table className="rw-headers-table rw-headers-table--readonly">
      <caption className="rw-visually-hidden">{t('response.networkCaption')}</caption>
      <tbody>
        <tr>
          <th scope="row">{t('response.networkWaitingLabel')}</th>
          <td>{waitingMs} ms</td>
        </tr>
        <tr>
          <th scope="row">{t('response.networkDownloadLabel')}</th>
          <td>{downloadMs} ms</td>
        </tr>
        <tr>
          <th scope="row">{t('response.networkTotalLabel')}</th>
          <td>{durationMs} ms</td>
        </tr>
        <tr>
          <th scope="row">{t('response.networkRemoteAddressLabel')}</th>
          <td>{connection.remoteAddress ?? t('response.networkUnknown')}</td>
        </tr>
        <tr>
          <th scope="row">{t('response.networkHttpVersionLabel')}</th>
          <td>{connection.httpVersion}</td>
        </tr>
        <tr>
          <th scope="row">{t('response.networkTlsLabel')}</th>
          <td>{connection.tlsCertificatePresent ? t('response.networkTlsPresent') : t('response.networkTlsAbsent')}</td>
        </tr>
        {connection.tlsCertificatePresent && (
          <tr>
            <th scope="row">{t('response.networkVerificationLabel')}</th>
            <td>{connection.certificateVerificationDisabled ? t('response.networkVerificationOff') : t('response.networkVerificationOn')}</td>
          </tr>
        )}
        <tr>
          <th scope="row">{t('response.networkRedirectedLabel')}</th>
          <td>{finalUrl ?? t('response.networkNoRedirect')}</td>
        </tr>
      </tbody>
    </table>
  )
}
