import { useMemo, useState } from 'react'
import { t } from '../i18n'
import type { HttpResult, SendMode } from '../transport'

/** Acima disso o `<pre>` mostra só o início, para não travar a página. */
const DISPLAY_LIMIT = 2 * 1024 * 1024

export type ResponseState =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'done'; result: HttpResult; mode: SendMode }
  | { status: 'error'; message: string }

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function prettyBody(body: string, headers: [string, string][]): string {
  const contentType = headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? ''
  const looksJson = contentType.includes('json') || /^\s*[[{]/.test(body)
  if (!looksJson || body.length > DISPLAY_LIMIT) return body
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

const statusTone = (status: number) => (status >= 500 ? 'error' : status >= 400 ? 'warning' : 'success')

function ResultView({ result, mode }: { result: HttpResult; mode: SendMode }) {
  const [tab, setTab] = useState<'body' | 'headers'>('body')
  const body = useMemo(() => prettyBody(result.body, result.headers), [result])
  const displayTruncated = body.length > DISPLAY_LIMIT

  return (
    <>
      <div className="wc-response__meta">
        <span className={`wc-status wc-status--${statusTone(result.status)}`}>
          {result.status} {result.statusText}
        </span>
        <span className="wc-muted">{result.durationMs} ms</span>
        <span className="wc-muted">{formatSize(result.size)}</span>
      </div>
      {result.truncated && <p className="wc-alert wc-alert--warning">{t('response.truncated')}</p>}
      <div className="wc-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'body'} className={`wc-tab${tab === 'body' ? ' wc-tab--active' : ''}`} onClick={() => setTab('body')}>
          {t('response.body')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'headers'}
          className={`wc-tab${tab === 'headers' ? ' wc-tab--active' : ''}`}
          onClick={() => setTab('headers')}
        >
          {t('response.headers')} ({result.headers.length})
        </button>
      </div>
      {tab === 'body' ? (
        <div className="wc-response__body">
          {displayTruncated && <p className="wc-muted">{t('response.displayTruncated')}</p>}
          <pre className="wc-pre">{displayTruncated ? body.slice(0, DISPLAY_LIMIT) : body}</pre>
        </div>
      ) : (
        <div className="wc-response__body">
          {mode === 'direct' && <p className="wc-muted">{t('response.corsHeaders')}</p>}
          <table className="wc-fields__table">
            <tbody>
              {result.headers.map(([name, value], index) => (
                <tr key={index}>
                  <td className="wc-mono">{name}</td>
                  <td className="wc-mono wc-break">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

export function ResponseView({ state }: { state: ResponseState }) {
  return (
    <section className="wc-response" aria-label={t('response.title')} aria-busy={state.status === 'sending'}>
      {state.status === 'idle' && <p className="wc-muted wc-response__placeholder">{t('response.empty')}</p>}
      {state.status === 'sending' && <p className="wc-muted wc-response__placeholder">{t('response.sending')}</p>}
      {state.status === 'error' && (
        <p className="wc-alert wc-alert--error" role="alert">
          {state.message}
        </p>
      )}
      {state.status === 'done' && <ResultView result={state.result} mode={state.mode} />}
    </section>
  )
}
