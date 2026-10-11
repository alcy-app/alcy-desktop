import { useEffect, useMemo, useRef, useState } from 'react'
import { effectiveAuthentication, prepareRequest, type PrepareError } from '../build-request'
import { loadRememberedValues, storeRememberedValues } from '../credentials'
import { indexRequests } from '../data'
import { t } from '../i18n'
import { detectServer, execute, TransportError, type SendMode, type TransportFailure } from '../transport'
import type { CredentialValues, Snapshot, TransportMode, WebclientRequest } from '../types'
import { CredentialsPanel } from './CredentialsPanel'
import { RequestEditor } from './RequestEditor'
import { RequestTree } from './RequestTree'
import { ResponseView, type ResponseState } from './ResponseView'

function prepareErrorMessage(error: PrepareError): string {
  switch (error.kind) {
    case 'missingVariables':
      return t('error.missingVariables', { names: error.names.join(', ') })
    case 'invalidVariables':
      return t('error.invalidVariables', { message: error.message })
    case 'unsupported':
      return t('error.unsupported')
  }
}

function transportErrorMessage(failure: TransportFailure): string {
  switch (failure.kind) {
    case 'aborted':
      return t('error.aborted')
    case 'network':
      return failure.mode === 'direct'
        ? t('error.networkDirect', { message: failure.message })
        : t('error.networkServer', { message: failure.message })
    case 'server':
      return t('error.server', { status: failure.status, code: failure.code, message: failure.message })
    case 'oauth2':
      return t('error.oauth2', { message: failure.message })
  }
}

export function Workbench({ snapshot }: { snapshot: Snapshot }) {
  const entries = useMemo(() => indexRequests(snapshot.root), [snapshot])
  const [selectedId, setSelectedId] = useState<string | null>(() => entries.keys().next().value ?? null)
  const [drafts, setDrafts] = useState<Record<string, WebclientRequest>>({})
  const [remembered] = useState(() => loadRememberedValues(snapshot.exportId))
  const [values, setValues] = useState<CredentialValues>(() => remembered ?? {})
  const [remember, setRemember] = useState(remembered !== null)
  const missingCredentials = snapshot.credentials.filter((credential) => !credential.included && !values[credential.id]).length
  const [showCredentials, setShowCredentials] = useState(missingCredentials > 0)
  const [mode, setMode] = useState<TransportMode>(snapshot.transport)
  const [serverAvailable, setServerAvailable] = useState(false)
  const [responses, setResponses] = useState<Record<string, ResponseState>>({})
  const controllers = useRef(new Map<string, AbortController>())

  // O título só aparece depois de aberto: num export com senha ele também é dado protegido.
  useEffect(() => {
    document.title = snapshot.title
  }, [snapshot.title])

  useEffect(() => {
    let active = true
    void detectServer().then((available) => {
      if (active) setServerAvailable(available)
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const running = controllers.current
    return () => running.forEach((controller) => controller.abort())
  }, [])

  const sendMode: SendMode = mode === 'auto' ? (serverAvailable ? 'server' : 'direct') : mode
  const entry = selectedId ? entries.get(selectedId) : undefined
  const request = entry && selectedId ? (drafts[selectedId] ?? entry.request) : undefined

  const updateValues = (next: CredentialValues, keep = remember) => {
    setValues(next)
    storeRememberedValues(snapshot.exportId, keep ? next : null)
  }

  const setResponse = (id: string, state: ResponseState) => setResponses((current) => ({ ...current, [id]: state }))

  const send = async () => {
    if (!entry || !request) return
    const id = request.id
    const prepared = prepareRequest(request, entry.chain, snapshot, values)
    if (!prepared.ok) {
      setResponse(id, { status: 'error', message: prepareErrorMessage(prepared.error) })
      return
    }
    const controller = new AbortController()
    controllers.current.set(id, controller)
    setResponse(id, { status: 'sending' })
    try {
      const result = await execute(prepared.call, prepared.oauth2, sendMode, controller.signal)
      setResponse(id, { status: 'done', result, mode: sendMode })
    } catch (error) {
      const message = error instanceof TransportError ? transportErrorMessage(error.failure) : String(error)
      setResponse(id, { status: 'error', message })
    } finally {
      controllers.current.delete(id)
    }
  }

  const effective = entry && request ? effectiveAuthentication(request, entry.chain) : null
  const responseState: ResponseState = (request && responses[request.id]) || { status: 'idle' }

  return (
    <div className="wc-app">
      <header className="wc-header">
        <div className="wc-header__title">
          <h1>{snapshot.title}</h1>
          {snapshot.environment && <span className="wc-badge">{snapshot.environment.name}</span>}
        </div>
        <div className="wc-header__actions">
          <label className="wc-inline-field">
            <span className="wc-muted">{t('header.transport')}</span>
            <select className="wc-select" value={mode} onChange={(event) => setMode(event.target.value as TransportMode)}>
              <option value="auto">{t('transport.auto')}</option>
              <option value="direct">{t('transport.direct')}</option>
              <option value="server">{t('transport.server')}</option>
            </select>
          </label>
          {mode === 'auto' && (
            <span className="wc-muted">{serverAvailable ? t('transport.autoResolvedServer') : t('transport.autoResolvedDirect')}</span>
          )}
          <button
            type="button"
            className="wc-button wc-button--ghost"
            aria-expanded={showCredentials}
            onClick={() => setShowCredentials((open) => !open)}
          >
            {t('header.credentials')}
            {missingCredentials > 0 && <span className="wc-count">{missingCredentials}</span>}
          </button>
        </div>
      </header>
      <div className="wc-body">
        <RequestTree root={snapshot.root} selectedId={selectedId} onSelect={setSelectedId} />
        <main className="wc-main">
          {request && effective && (
            <RequestEditor
              key={request.id}
              request={request}
              edited={drafts[request.id] !== undefined}
              authentication={effective.authentication}
              inherited={effective.ownerId !== request.id}
              authenticationHasCredentials={snapshot.credentials.some(
                (credential) => credential.target.kind === 'authentication' && credential.target.nodeId === effective.ownerId,
              )}
              sending={responseState.status === 'sending'}
              onChange={(next) => setDrafts((current) => ({ ...current, [next.id]: next }))}
              onReset={() =>
                setDrafts((current) => {
                  const next = { ...current }
                  delete next[request.id]
                  return next
                })
              }
              onSend={() => void send()}
              onCancel={() => controllers.current.get(request.id)?.abort()}
            />
          )}
          <ResponseView state={responseState} />
        </main>
        {showCredentials && (
          <CredentialsPanel
            credentials={snapshot.credentials}
            values={values}
            remember={remember}
            onChange={(id, value) => updateValues({ ...values, [id]: value })}
            onRememberChange={(keep) => {
              setRemember(keep)
              storeRememberedValues(snapshot.exportId, keep ? values : null)
            }}
            onClear={() => updateValues({})}
            onClose={() => setShowCredentials(false)}
          />
        )}
      </div>
    </div>
  )
}
