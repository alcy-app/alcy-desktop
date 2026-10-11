import type { ResponseBodyOutput, ResponseHeader } from '../../../bindings/execute-graphql-request'
import { useLanguage } from '../../../shared/i18n/use-language'

interface RawExchangeViewProps {
  method: string
  url: string
  requestHeaders: ResponseHeader[]
  requestBody: string
  statusCode: number
  responseHeaders: ResponseHeader[]
  responseBody: ResponseBodyOutput
}

function headerLines(headers: ResponseHeader[]): string {
  return headers.map((header) => `${header.name}: ${header.value}`).join('\n')
}

/** Corpo `windowed` (grande demais para atravessar o IPC inteiro) mostra
 * só a prévia aqui — buscar o restante só para esta
 * visualização repetiria o custo que a aba Body já paga sob demanda. */
export function RawExchangeView({
  method,
  url,
  requestHeaders,
  requestBody,
  statusCode,
  responseHeaders,
  responseBody,
}: RawExchangeViewProps) {
  const { t } = useLanguage()

  const requestLines = [`${method.toUpperCase()} ${url}`, headerLines(requestHeaders)]
  if (requestBody) requestLines.push('', requestBody)
  const requestText = requestLines.filter((line) => line !== '').join('\n')

  const isTruncated = responseBody.kind === 'windowed'
  const responseBodyText = responseBody.kind === 'inline' ? responseBody.body : responseBody.preview
  const responseLines = [`HTTP ${statusCode}`, headerLines(responseHeaders), '', responseBodyText]
  const responseText = responseLines.filter((line) => line !== '').join('\n')

  return (
    <div className="rw-code-block-wrapper">
      <p className="rw-raw-section-label">{t('response.rawRequestLabel')}</p>
      <pre className="rw-code-block">{requestText}</pre>
      <p className="rw-raw-section-label">{t('response.rawResponseLabel')}</p>
      <pre className="rw-code-block">{responseText}</pre>
      {isTruncated && <p className="rw-code-block-notice">{t('response.rawBodyTruncatedNotice')}</p>}
    </div>
  )
}
