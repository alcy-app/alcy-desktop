import { useState } from 'react'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import type { ConsoleEntryDetail } from '../use-console-state'
import { CookiesList } from './CookiesList'
import { RawExchangeView } from './RawExchangeView'
import { ResponseBody } from './ResponseBody'
import { ResponseHeadersList } from './ResponseHeadersList'
import { ResponseNetworkInfo } from './ResponseNetworkInfo'

interface ConsoleEntryDetailViewProps {
  endpointUrl: string
  statusCode: number | null
  detail: ConsoleEntryDetail
}

export function ConsoleEntryDetailView({ endpointUrl, statusCode, detail }: ConsoleEntryDetailViewProps) {
  const { t } = useLanguage()
  const [showRaw, setShowRaw] = useState(false)

  return (
    <div className="console-entry-detail-content">
      <details className="console-entry-section">
        <summary>{t('devConsole.networkSectionLabel')}</summary>
        <ResponseNetworkInfo
          connection={detail.connection}
          waitingMs={detail.waitingMs}
          durationMs={detail.durationMs}
          finalUrl={detail.finalUrl}
        />
      </details>
      <details className="console-entry-section">
        <summary>{t('devConsole.requestHeadersSectionLabel')}</summary>
        <ResponseHeadersList
          headers={detail.requestHeaders}
          emptyMessageKey="response.noRequestHeaders"
          captionKey="response.requestHeadersCaption"
        />
      </details>
      <details className="console-entry-section">
        <summary>{t('devConsole.requestBodySectionLabel')}</summary>
        {detail.requestBody === '' ? (
          <p className="rw-status-message">{t('devConsole.noRequestBody')}</p>
        ) : (
          // Same viewer as the response body; the sent `Content-Type` picks the formatting (JSON, XML…).
          <ResponseBody body={{ kind: 'inline', body: detail.requestBody }} bodyEncoding="text" headers={detail.requestHeaders} />
        )}
      </details>
      <details className="console-entry-section">
        <summary>{t('devConsole.cookiesSectionLabel')}</summary>
        <CookiesList cookies={detail.cookies} />
      </details>
      <details className="console-entry-section">
        <summary>{t('devConsole.responseHeadersSectionLabel')}</summary>
        <ResponseHeadersList headers={detail.responseHeaders} />
      </details>
      <details className="console-entry-section">
        <summary>{t('devConsole.responseBodySectionLabel')}</summary>
        {detail.truncated && <p className="rw-status-message">{t('devConsole.bodyTruncated')}</p>}
        <ResponseBody body={detail.body} bodyEncoding={detail.bodyEncoding} headers={detail.responseHeaders} />
      </details>
      <Button variant="ghost" size="sm" onClick={() => setShowRaw((current) => !current)}>
        {showRaw ? t('devConsole.hideRawToggle') : t('devConsole.showRawToggle')}
      </Button>
      {showRaw && (
        <div className="console-entry-raw">
          <RawExchangeView
            method={detail.method}
            url={endpointUrl}
            requestHeaders={detail.requestHeaders}
            requestBody={detail.requestBody}
            statusCode={statusCode ?? 0}
            responseHeaders={detail.responseHeaders}
            responseBody={detail.body}
          />
        </div>
      )}
    </div>
  )
}
