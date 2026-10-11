import { useState, type FormEvent } from 'react'
import { t, type MessageKey } from '../i18n'
import type { Authentication, Field, WebclientRequest } from '../types'
import { FieldsTable } from './FieldsTable'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

type Tab = 'query' | 'variables' | 'headers' | 'body' | 'auth' | 'route'

interface RequestEditorProps {
  request: WebclientRequest
  edited: boolean
  /** Autenticação efetiva e se ela veio de uma pasta. */
  authentication: Authentication
  inherited: boolean
  /** Há credencial a preencher para esta autenticação. */
  authenticationHasCredentials: boolean
  sending: boolean
  onChange: (request: WebclientRequest) => void
  onReset: () => void
  onSend: () => void
  onCancel: () => void
}

const AUTH_LABEL: Record<Exclude<Authentication['type'], 'none' | 'inherit'>, MessageKey> = {
  bearer: 'auth.bearer',
  basic: 'auth.basic',
  digest: 'auth.digest',
  customHeader: 'auth.customHeader',
  oauth2ClientCredentials: 'auth.oauth2ClientCredentials',
}

function AuthenticationSummary({
  authentication,
  inherited,
  hasCredentials,
}: {
  authentication: Authentication
  inherited: boolean
  hasCredentials: boolean
}) {
  if (authentication.type === 'none' || authentication.type === 'inherit') return <p className="wc-muted">{t('auth.none')}</p>
  const label = t(AUTH_LABEL[authentication.type])
  return (
    <div className="wc-stack">
      <p>{inherited ? t('auth.inherit', { type: label }) : label}</p>
      {authentication.type === 'basic' || authentication.type === 'digest' ? (
        <p className="wc-muted wc-mono">{authentication.username}</p>
      ) : null}
      {authentication.type === 'customHeader' ? <p className="wc-muted wc-mono">{authentication.name}</p> : null}
      {authentication.type === 'oauth2ClientCredentials' ? (
        <p className="wc-muted wc-mono">{authentication.tokenUrl}</p>
      ) : null}
      {hasCredentials && <p className="wc-muted">{t('auth.fillInCredentials')}</p>}
    </div>
  )
}

export function RequestEditor({
  request,
  edited,
  authentication,
  inherited,
  authenticationHasCredentials,
  sending,
  onChange,
  onReset,
  onSend,
  onCancel,
}: RequestEditorProps) {
  const isGraphql = request.protocol === 'graphql'
  const tabs: { id: Tab; label: string }[] = [
    ...(isGraphql
      ? [
          { id: 'query' as const, label: t('editor.query') },
          { id: 'variables' as const, label: t('editor.variables') },
        ]
      : [{ id: 'body' as const, label: t('editor.body') }]),
    { id: 'headers', label: t('editor.headers') },
    { id: 'auth', label: t('editor.auth') },
    ...(request.routeParameters.length > 0 ? [{ id: 'route' as const, label: t('editor.routeParameters') }] : []),
  ]
  const [selectedTab, setSelectedTab] = useState<Tab>(tabs[0].id)
  const tab = tabs.some((candidate) => candidate.id === selectedTab) ? selectedTab : tabs[0].id

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (sending) onCancel()
    else onSend()
  }

  const updateFields = (fields: Field[]) => {
    const payload = request.bodyPayload
    if (payload.type === 'urlEncoded' || payload.type === 'formData') onChange({ ...request, bodyPayload: { ...payload, fields } })
  }

  return (
    <section className="wc-editor">
      <form className="wc-editor__bar" onSubmit={submit}>
        {isGraphql ? (
          <span className="wc-method wc-method--graphql">GQL</span>
        ) : (
          <select
            className="wc-select"
            aria-label={t('editor.method')}
            value={request.method}
            onChange={(event) => onChange({ ...request, method: event.target.value })}
          >
            {METHODS.map((method) => (
              <option key={method}>{method}</option>
            ))}
          </select>
        )}
        <input
          className="wc-input wc-input--mono wc-editor__url"
          aria-label={t('editor.url')}
          value={request.url}
          onChange={(event) => onChange({ ...request, url: event.target.value })}
        />
        <button type="submit" className={`wc-button ${sending ? 'wc-button--ghost' : 'wc-button--primary'}`}>
          {sending ? t('editor.cancel') : t('editor.send')}
        </button>
      </form>

      {request.unsupported.length > 0 && (
        <div className="wc-alert wc-alert--warning" role="note">
          {request.unsupported.map((feature) => (
            <p key={feature}>{t(`unsupported.${feature}`)}</p>
          ))}
        </div>
      )}

      <div className="wc-tabs" role="tablist" aria-label={t('editor.tabs')}>
        {tabs.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            role="tab"
            aria-selected={tab === candidate.id}
            className={`wc-tab${tab === candidate.id ? ' wc-tab--active' : ''}`}
            onClick={() => setSelectedTab(candidate.id)}
          >
            {candidate.label}
          </button>
        ))}
      </div>

      <div className="wc-editor__panel" role="tabpanel">
        {tab === 'query' && (
          <textarea
            className="wc-textarea"
            aria-label={t('editor.query')}
            spellCheck={false}
            value={request.body}
            onChange={(event) => onChange({ ...request, body: event.target.value })}
          />
        )}
        {tab === 'variables' && (
          <textarea
            className="wc-textarea"
            aria-label={t('editor.variables')}
            spellCheck={false}
            value={request.variables}
            onChange={(event) => onChange({ ...request, variables: event.target.value })}
          />
        )}
        {tab === 'body' &&
          (request.bodyPayload.type === 'urlEncoded' || request.bodyPayload.type === 'formData' ? (
            <FieldsTable label={t('editor.fieldsBody')} fields={request.bodyPayload.fields} onChange={updateFields} />
          ) : request.bodyPayload.type === 'binary' ? (
            <p className="wc-muted">{t('unsupported.binaryBody')}</p>
          ) : (
            <textarea
              className="wc-textarea"
              aria-label={t('editor.body')}
              spellCheck={false}
              placeholder={t('editor.noBody')}
              value={request.body}
              onChange={(event) => onChange({ ...request, body: event.target.value })}
            />
          ))}
        {tab === 'headers' && (
          <FieldsTable
            label={t('editor.headers')}
            fields={request.headers}
            onChange={(headers) => onChange({ ...request, headers })}
            addLabel={t('editor.addHeader')}
          />
        )}
        {tab === 'auth' && (
          <AuthenticationSummary authentication={authentication} inherited={inherited} hasCredentials={authenticationHasCredentials} />
        )}
        {tab === 'route' && (
          <FieldsTable
            label={t('editor.routeParameters')}
            withoutToggle
            fields={request.routeParameters.map((parameter) => ({ ...parameter, enabled: true }))}
            onChange={(fields) => onChange({ ...request, routeParameters: fields.map(({ name, value }) => ({ name, value })) })}
          />
        )}
      </div>

      <footer className="wc-editor__footer">
        <span className="wc-muted">{t('editor.sessionOnly')}</span>
        {edited && (
          <button type="button" className="wc-button wc-button--ghost" onClick={onReset}>
            {t('editor.reset')}
          </button>
        )}
      </footer>
    </section>
  )
}
