import { useCallback, useEffect, useState } from 'react'
import {
  clearMockCalls, deleteMockServer, getMockServer, listMockCalls, listMockServers,
  saveMockServer, startMockServer, stopMockServer,
  type MockCallLogDto, type MockResponseDto, type MockRouteDto,
  type MockServerDto, type MockServerSummaryDto, type MockServersError,
} from '../../bindings/mock-servers'
import { useLanguage } from '../../shared/i18n/use-language'
import type { TranslationKey, TranslationParams } from '../../shared/i18n/translations'
import { Button } from '../../shared/ui/Button'
import { Checkbox } from '../../shared/ui/Checkbox'
import { IconButton } from '../../shared/ui/IconButton'
import { Input } from '../../shared/ui/Input'
import { SegmentedControl } from '../../shared/ui/SegmentedControl'
import { Select } from '../../shared/ui/Select'
import { Tabs } from '../../shared/ui/Tabs'
import {
  ClockIcon, CopyIcon, GearIcon, GlobeIcon, MockServerIcon, PlayIcon,
  PlusIcon, RefreshIcon, SaveIcon, SearchIcon, StopIcon, TrashIcon,
} from '../../shared/ui/icons'
import { RequestBodyPanel } from '../request-workbench/components/RequestBodyPanel'
import { VirtualizedList } from '../request-workbench/components/VirtualizedList'
import { MockRuleBuilder } from './MockRuleBuilder'
import { MOCK_SERVERS_CHANGED_EVENT, mockErrorMessage, newMockResponse, newMockRoute } from './mock-server-defaults'
import { parseConditionGroup, routePathParameters } from './mock-rules'
import './mock-servers.css'

type ServerSection = 'routes' | 'settings' | 'calls'
type ResponseSection = 'body' | 'headers' | 'rules'
type RulesMode = 'visual' | 'json'
type Translate = (key: TranslationKey, params?: TranslationParams) => string

/** Mock avulso de um bloco "Ligar mock" (spec 0121): vem do flow e "Salvar"
 * grava de volta no bloco. `server` é `null` quando o bloco não existe mais.
 * `onSave` devolve `false` quando não conseguiu gravar. */
export interface InlineMockServer {
  server: MockServerDto | null
  onSave: (server: MockServerDto) => boolean
}

interface MockServerEditorProps {
  rootPath: string
  serverId: string
  active?: boolean
  onTabChange: (serverId: string, patch: { label?: string; dirty?: boolean }) => void
  onDeleted: () => void
  inline?: InlineMockServer
}

/** O que o backend rejeitaria ao salvar o flow — conferido antes de gravar o
 * mock avulso no bloco, já que o erro do flow só apareceria depois. */
function inlineMockError(server: MockServerDto, t: Translate): string | null {
  if (!server.name.trim()) return t('mockServers.error.nameRequired')
  if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) return t('mockServers.error.invalidPort')
  if (server.routes.some((route) => !route.path.startsWith('/'))) return t('mockServers.error.pathMustStartWithSlash')
  return null
}

export function MockServerEditor({ rootPath, serverId, active = true, onTabChange, onDeleted, inline }: MockServerEditorProps) {
  const { t } = useLanguage()
  const isInline = inline !== undefined
  const [server, setServer] = useState<MockServerDto | null>(inline?.server ?? null)
  const [summary, setSummary] = useState<MockServerSummaryDto | null>(null)
  const [calls, setCalls] = useState<MockCallLogDto[]>([])
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  // Traduzidos na renderização: incluir `t` no efeito de carga recarregaria o servidor (e descartaria edições) ao trocar de idioma.
  const [loadError, setLoadError] = useState<MockServersError | null>(null)
  const [section, setSection] = useState<ServerSection>('routes')
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(inline?.server?.routes[0]?.id ?? null)
  const [search, setSearch] = useState('')
  const [invalidRules, setInvalidRules] = useState<Record<string, string>>({})
  const [ruleDrafts, setRuleDrafts] = useState<Record<string, string>>({})
  const [initialInlineServer] = useState(inline?.server ?? null)

  useEffect(() => {
    if (isInline) {
      if (initialInlineServer) onTabChange(serverId, { label: initialInlineServer.name, dirty: false })
      return
    }
    let cancelled = false
    void Promise.all([
      getMockServer(rootPath, serverId), listMockServers(rootPath), listMockCalls(serverId),
    ]).then(([serverResult, listResult, callsResult]) => {
      if (cancelled) return
      if (!serverResult.ok) { setLoadError(serverResult.error); return }
      setServer(serverResult.value)
      setSelectedRouteId(serverResult.value.routes[0]?.id ?? null)
      setSummary(listResult.ok ? listResult.value.servers.find((item) => item.id === serverId) ?? null : null)
      if (callsResult.ok) setCalls(callsResult.value)
      onTabChange(serverId, { label: serverResult.value.name, dirty: false })
    })
    return () => { cancelled = true }
  }, [initialInlineServer, isInline, onTabChange, rootPath, serverId])

  const update = (updater: (value: MockServerDto) => MockServerDto) => {
    setServer((value) => value ? updater(value) : value)
    setDirty(true)
    setMessage(null)
    onTabChange(serverId, { dirty: true })
  }

  const save = useCallback(async () => {
    if (!server || busy || Object.keys(invalidRules).length > 0) return
    if (inline) {
      const error = inlineMockError(server, t)
      if (error) { setMessage(error); return }
      if (!inline.onSave(server)) { setMessage(t('mockServers.editor.inlineBlockMissing')); return }
      setDirty(false)
      setMessage(t('mockServers.editor.savedToFlow'))
      onTabChange(serverId, { label: server.name, dirty: false })
      return
    }
    setBusy(true)
    const result = await saveMockServer(rootPath, server)
    setBusy(false)
    if (!result.ok) { setMessage(mockErrorMessage(result.error, t)); return }
    setDirty(false)
    setMessage(t('mockServers.editor.saved'))
    onTabChange(serverId, { label: server.name, dirty: false })
    window.dispatchEvent(new Event(MOCK_SERVERS_CHANGED_EVENT))
  }, [busy, inline, invalidRules, onTabChange, rootPath, server, serverId, t])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (active && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && dirty) {
        event.preventDefault()
        void save()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [active, dirty, save])

  const refreshCalls = async () => {
    const result = await listMockCalls(serverId)
    if (result.ok) setCalls(result.value)
    else setMessage(mockErrorMessage(result.error, t))
  }

  if (!server) {
    return <article className="mock-server-editor mock-server-editor--loading" hidden={!active}>
      <MockServerIcon size={28} />
      <p role="status">{isInline ? t('mockServers.editor.inlineBlockMissing') : loadError ? mockErrorMessage(loadError, t) : t('mockServers.editor.loading')}</p>
    </article>
  }

  const selectedRoute = server.routes.find((route) => route.id === selectedRouteId) ?? server.routes[0]
  const filteredRoutes = server.routes.filter((route) =>
    (route.name + ' ' + route.method + ' ' + route.path).toLowerCase().includes(search.toLowerCase()),
  )
  const hasInvalidRules = Object.keys(invalidRules).length > 0

  const toggleServer = async () => {
    setBusy(true)
    const running = summary?.running === true
    const result = running ? await stopMockServer(rootPath, server.id) : await startMockServer(rootPath, server.id)
    setBusy(false)
    if (!result.ok) { setMessage(mockErrorMessage(result.error, t)); return }
    setSummary({ id: server.id, name: server.name, port: server.port, routesCount: server.routes.length, running: !running })
    setMessage(running ? t('mockServers.editor.serverStopped') : t('mockServers.editor.serverStarted'))
    window.dispatchEvent(new Event(MOCK_SERVERS_CHANGED_EVENT))
  }
  const remove = async () => {
    if (!confirm(t('mockServers.editor.confirmDelete', { name: server.name }))) return
    const result = await deleteMockServer(rootPath, server.id)
    if (result.ok) { window.dispatchEvent(new Event(MOCK_SERVERS_CHANGED_EVENT)); onDeleted() }
    else setMessage(mockErrorMessage(result.error, t))
  }
  const addRoute = () => {
    const route = newMockRoute(t)
    update((value) => ({ ...value, routes: [...value.routes, route] }))
    setSelectedRouteId(route.id)
    setSearch('')
  }
  const removeInvalidRules = (ids: string[]) => setInvalidRules((current) =>
    Object.fromEntries(Object.entries(current).filter(([id]) => !ids.includes(id))),
  )
  const removeRoute = (route: MockRouteDto) => {
    update((value) => ({ ...value, routes: value.routes.filter((item) => item.id !== route.id) }))
    removeInvalidRules(route.alternatives.map((response) => response.id))
  }
  const copyEndpoint = async () => {
    try {
      await navigator.clipboard.writeText('http://127.0.0.1:' + server.port)
      setMessage(t('mockServers.editor.urlCopied'))
    } catch { setMessage(t('mockServers.editor.urlCopyFailed')) }
  }
  const prefix = 'mock-' + serverId + '-'

  return <article className="mock-server-editor" hidden={!active}>
    <header className="mock-server-editor__header">
      <div className="mock-server-editor__identity">
        <span className="mock-server-editor__server-icon"><MockServerIcon size={21} /></span>
        <div>
          <h2>{server.name || t('mockServers.title')}</h2>
          <div className="mock-server-editor__address">
            <code>http://127.0.0.1:{server.port}</code>
            <IconButton icon={<CopyIcon size={12} />} label={t('mockServers.editor.copyUrl')} onClick={() => void copyEndpoint()} />
          </div>
        </div>
        {isInline
          ? <span className="mock-server-state">{t('mockServers.editor.inlineState')}</span>
          : <span className={summary?.running ? 'mock-server-state mock-server-state--running' : 'mock-server-state'}>
            <span />{summary?.running ? t('mockServers.editor.running') : t('mockServers.editor.stopped')}
          </span>}
      </div>
      <div className="mock-server-editor__actions">
        {!isInline && <Button variant={summary?.running ? 'danger' : 'success'} onClick={() => void toggleServer()} disabled={dirty || busy} title={dirty ? t('mockServers.editor.saveBeforeToggle') : undefined}>
          {summary?.running ? <StopIcon size={14} /> : <PlayIcon size={14} />}{summary?.running ? t('mockServers.editor.stop') : t('mockServers.editor.start')}
        </Button>}
        <Button onClick={() => void save()} disabled={!dirty || busy || hasInvalidRules}><SaveIcon size={14} />{t('mockServers.editor.save')}</Button>
      </div>
    </header>

    <Tabs<ServerSection>
      className="mock-server-editor__navigation"
      ariaLabel={t('mockServers.editor.sectionsAria')} idPrefix={prefix}
      activeTab={section} onChange={(next) => { setSection(next); if (next === 'calls') void refreshCalls() }}
      tabs={[
        { id: 'routes', label: <><GlobeIcon size={14} />{t('mockServers.editor.routesTab')}</>, badge: server.routes.length },
        { id: 'settings', label: <><GearIcon size={14} />{t('mockServers.editor.settingsTab')}</> },
        // O mock avulso só existe durante um run; as chamadas aparecem no log do run.
        ...(isInline ? [] : [{ id: 'calls' as const, label: <><ClockIcon size={14} />{t('mockServers.editor.callsTab')}</>, badge: calls.length }]),
      ]}
    />
    {isInline && <div className="mock-server-editor__notice" role="note">{t('mockServers.editor.inlineNotice')}</div>}
    {message && <div className="mock-server-editor__notice" role="status">{message}</div>}
    {hasInvalidRules && <div className="mock-server-editor__notice mock-server-editor__notice--error" role="alert">{t('mockServers.editor.invalidRulesJson')}</div>}

    <div className="mock-server-editor__page" role="tabpanel" id={'tabpanel-' + prefix + section} aria-labelledby={'tab-' + prefix + section}>
      {section === 'routes' ? <div className="mock-routes-layout">
        <aside className="mock-routes-browser" aria-label={t('mockServers.editor.routesNavigation')}>
          <div className="mock-routes-browser__heading"><h3>{t('mockServers.editor.endpoints')} <span>{server.routes.length}</span></h3><IconButton icon={<PlusIcon size={15} />} label={t('mockServers.editor.addRoute')} onClick={addRoute} /></div>
          <div className="mock-routes-browser__search"><SearchIcon size={13} /><Input aria-label={t('mockServers.editor.searchRoutes')} placeholder={t('mockServers.editor.searchRoutesPlaceholder')} value={search} onChange={(event) => setSearch(event.target.value)} /></div>
          {filteredRoutes.length > 0 ? <VirtualizedList
            className="mock-routes-browser__list" ariaLabel={t('mockServers.editor.routesList')}
            items={filteredRoutes} getKey={(route) => route.id} estimatedRowHeight={68}
            renderItem={(route) => <button
              type="button" className="mock-route-item" aria-current={selectedRoute?.id === route.id ? 'true' : undefined}
              aria-label={t('mockServers.editor.routeItemAria', { method: route.method, name: route.name || t('mockServers.editor.unnamed'), path: route.path, state: route.enabled ? t('mockServers.editor.routeEnabledState') : t('mockServers.editor.routeDisabledState') })}
              onClick={() => setSelectedRouteId(route.id)}
            >
              <span className={'mock-method mock-method--' + route.method.toLowerCase()}>{route.method}</span>
              <span className="mock-route-item__copy"><strong>{route.name || t('mockServers.editor.unnamed')}</strong><code>{route.path || '/'}</code></span>
              <span className={route.enabled ? 'mock-route-item__dot' : 'mock-route-item__dot mock-route-item__dot--disabled'} title={route.enabled ? t('mockServers.editor.routeEnabled') : t('mockServers.editor.routeDisabled')} />
            </button>}
          /> : <div className="mock-routes-browser__empty">{search ? t('mockServers.editor.noRoutesFound') : t('mockServers.editor.noRoutesCreated')}</div>}
        </aside>
        {selectedRoute ? <RouteEditor
          key={selectedRoute.id} route={selectedRoute} invalidRules={invalidRules} ruleDrafts={ruleDrafts}
          onRuleDraft={(id, value) => setRuleDrafts((current) => {
            const rest = Object.fromEntries(Object.entries(current).filter(([key]) => key !== id))
            return value === null ? rest : { ...rest, [id]: value }
          })}
          onInvalidRule={(id, value) => {
            setInvalidRules((current) => ({ ...current, [id]: value }))
            setDirty(true)
            onTabChange(serverId, { dirty: true })
          }}
          onValidRule={(id) => removeInvalidRules([id])}
          onChange={(next) => update((value) => ({ ...value, routes: value.routes.map((route) => route.id === next.id ? next : route) }))}
          onDelete={() => removeRoute(selectedRoute)}
        /> : <div className="mock-server-empty"><GlobeIcon size={30} /><h3>{t('mockServers.editor.noRoutes')}</h3><Button onClick={addRoute}><PlusIcon size={14} />{t('mockServers.editor.addRoute')}</Button></div>}
      </div> : section === 'settings' ? <div className="mock-server-settings">
        <section className="mock-settings-card">
          <label>{t('mockServers.editor.serverName')}<Input value={server.name} onChange={(event) => update((value) => ({ ...value, name: event.target.value }))} /></label>
          <label>{t('mockServers.editor.address')}<div className="mock-server-settings__url"><span>http://</span><Input aria-label={t('mockServers.editor.serverHost')} value="127.0.0.1" mono readOnly /><span>:</span><Input aria-label={t('mockServers.editor.serverPort')} type="number" min="1" max="65535" value={server.port} disabled={summary?.running} onChange={(event) => update((value) => ({ ...value, port: Number(event.target.value) }))} /></div><small>{summary?.running ? t('mockServers.editor.stopToChangePort') : t('mockServers.editor.localOnly')}</small></label>
          <label className="mock-checkbox-row"><Checkbox checked={server.corsEnabled} onChange={(event) => update((value) => ({ ...value, corsEnabled: event.target.checked }))} />{t('mockServers.editor.enableCors')}</label>
        </section>
        {!isInline && <section className="mock-settings-card mock-settings-card--danger"><div><h4>{t('mockServers.editor.deleteServer')}</h4><p>{t('mockServers.editor.deleteServerHint')}</p></div><Button variant="danger" onClick={() => void remove()}><TrashIcon size={14} />{t('mockServers.editor.deleteServer')}</Button></section>}
      </div> : <div className="mock-calls">
        <div className="mock-page-heading"><ClockIcon size={20} /><div><h3>{t('mockServers.editor.receivedCalls')}</h3></div><div className="mock-calls__actions"><Button variant="ghost" onClick={() => void refreshCalls()}><RefreshIcon size={14} />{t('mockServers.editor.refresh')}</Button><Button variant="ghost" disabled={calls.length === 0} onClick={() => { void clearMockCalls(rootPath, server.id).then((result) => { if (result.ok) setCalls([]); else setMessage(mockErrorMessage(result.error, t)) }) }}>{t('mockServers.editor.clear')}</Button></div></div>
        {calls.length === 0 ? <div className="mock-server-empty"><ClockIcon size={30} /><h3>{t('mockServers.editor.noCalls')}</h3></div> : <>
          <div className="mock-call-row mock-call-row--heading"><span>{t('mockServers.editor.callMethod')}</span><span>{t('mockServers.editor.callRouteResponse')}</span><span>{t('mockServers.editor.callStatus')}</span><span>{t('mockServers.editor.callTime')}</span></div>
          <VirtualizedList items={calls} getKey={(call) => String(call.id)} estimatedRowHeight={57} ariaLabel={t('mockServers.editor.receivedCalls')} className="mock-calls__list" renderItem={(call) => <div className="mock-call-row"><span className={'mock-method mock-method--' + call.method.toLowerCase()}>{call.method}</span><span><strong>{call.routeName ?? t('mockServers.editor.routeNotFound')}</strong><small>{call.responseName ?? t('mockServers.editor.noResponseConfigured')}</small></span><span className={call.status < 400 ? 'mock-status mock-status--success' : 'mock-status mock-status--error'}>{call.status}</span><code>{call.durationMs} ms</code></div>} />
        </>}
      </div>}
    </div>
  </article>
}

interface RouteEditorProps {
  route: MockRouteDto
  invalidRules: Record<string, string>
  ruleDrafts: Record<string, string>
  onChange: (route: MockRouteDto) => void
  onDelete: () => void
  onInvalidRule: (id: string, value: string) => void
  onValidRule: (id: string) => void
  /** `null` descarta o rascunho JSON, que passa a ser gerado a partir das regras salvas no estado. */
  onRuleDraft: (id: string, value: string | null) => void
}

function RouteEditor({ route, invalidRules, ruleDrafts, onChange, onDelete, onInvalidRule, onValidRule, onRuleDraft }: RouteEditorProps) {
  const { t } = useLanguage()
  const [selectedResponseId, setSelectedResponseId] = useState(route.defaultResponse.id)
  const [section, setSection] = useState<ResponseSection>('body')
  const [rulesMode, setRulesMode] = useState<RulesMode>('visual')
  const responses = [route.defaultResponse, ...route.alternatives]
  const response = responses.find((item) => item.id === selectedResponseId) ?? route.defaultResponse
  const conditional = response.id !== route.defaultResponse.id
  const prefix = 'mock-response-' + route.id + '-'
  const updateResponse = (next: MockResponseDto) => onChange(next.id === route.defaultResponse.id
    ? { ...route, defaultResponse: next }
    : { ...route, alternatives: route.alternatives.map((item) => item.id === next.id ? next : item) })
  const addResponse = () => {
    const next = { ...newMockResponse(t('mockServers.alternativeName', { number: route.alternatives.length + 1 })), condition: { operator: 'all' as const, conditions: [] } }
    onChange({ ...route, alternatives: [...route.alternatives, next] })
    setSelectedResponseId(next.id)
    setSection('rules')
  }
  const removeResponse = () => {
    onValidRule(response.id)
    onChange({ ...route, alternatives: route.alternatives.filter((item) => item.id !== response.id) })
    setSelectedResponseId(route.defaultResponse.id)
  }
  const updateRules = (text: string) => {
    onRuleDraft(response.id, text)
    try {
      const condition = text.trim() === '' ? null : parseConditionGroup(JSON.parse(text))
      if (text.trim() !== '' && !condition) throw new Error()
      onValidRule(response.id)
      updateResponse({ ...response, condition })
    } catch { onInvalidRule(response.id, text) }
  }
  // JSON inválido só pode ser corrigido no próprio JSON; o editor visual fica indisponível até lá.
  const invalidJson = invalidRules[response.id] !== undefined
  const mode: RulesMode = invalidJson ? 'json' : rulesMode
  const changeRulesMode = (next: RulesMode) => {
    if (next === 'visual') onRuleDraft(response.id, null)
    setRulesMode(next)
  }
  const contentType = response.headers.find((header) => header.name.toLowerCase() === 'content-type')?.value ?? ''
  const language = contentType.includes('json') ? 'json' : contentType.includes('html') ? 'html' : contentType.includes('xml') ? 'xml' : 'none'

  return <section className="mock-route-editor" aria-label={t('mockServers.route.editAria', { name: route.name })}>
    <header className="mock-route-editor__heading">
      <div><h3>{route.name || t('mockServers.editor.unnamed')}</h3></div>
      <label className="mock-checkbox-row"><Checkbox checked={route.enabled} onChange={(event) => onChange({ ...route, enabled: event.target.checked })} />{t('mockServers.editor.routeEnabled')}</label>
      <IconButton icon={<TrashIcon size={15} />} variant="danger" label={t('mockServers.route.removeAria', { name: route.name })} onClick={onDelete} />
    </header>
    <div className="mock-route-editor__details">
      <label>{t('mockServers.route.name')}<Input value={route.name} onChange={(event) => onChange({ ...route, name: event.target.value })} /></label>
      <label>{t('mockServers.route.endpoint')}<div className="mock-route-editor__endpoint"><Select aria-label={t('mockServers.route.method')} className={'mock-method-select mock-method-select--' + route.method.toLowerCase()} value={route.method} onChange={(event) => onChange({ ...route, method: event.target.value })}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((method) => <option key={method}>{method}</option>)}</Select><Input aria-label={t('mockServers.route.path')} value={route.path} mono onChange={(event) => onChange({ ...route, path: event.target.value })} placeholder="/users/:id" /></div></label>
    </div>
    <div className="mock-response-picker">
      <label>{t('mockServers.route.response')}<Select aria-label={t('mockServers.route.responseSelect')} value={response.id} onChange={(event) => setSelectedResponseId(event.target.value)}>{responses.map((item, index) => <option key={item.id} value={item.id}>{item.name} · {index === 0 ? t('mockServers.route.defaultResponseTag') : t('mockServers.route.conditionalResponseTag')} · {item.status}</option>)}</Select></label>
      <Button variant="ghost" onClick={addResponse}><PlusIcon size={14} />{t('mockServers.route.addConditional')}</Button>
      {conditional && <IconButton icon={<TrashIcon size={14} />} variant="danger" label={t('mockServers.route.removeConditional')} onClick={removeResponse} />}
    </div>
    <div className="mock-response-meta">
      <label>{t('mockServers.route.responseName')}<Input value={response.name} onChange={(event) => updateResponse({ ...response, name: event.target.value })} /></label>
      <label>{t('mockServers.route.status')}<Input type="number" min="100" max="599" value={response.status} onChange={(event) => updateResponse({ ...response, status: Number(event.target.value) })} /></label>
      <label>{t('mockServers.route.delay')}<Input type="number" min="0" max="60000" value={response.delayMs} onChange={(event) => updateResponse({ ...response, delayMs: Number(event.target.value) })} /></label>
      {conditional && <label className="mock-checkbox-row"><Checkbox checked={response.enabled} onChange={(event) => updateResponse({ ...response, enabled: event.target.checked })} />{t('mockServers.route.responseEnabled')}</label>}
    </div>
    <Tabs<ResponseSection>
      className="mock-response-tabs" ariaLabel={t('mockServers.route.responseContent')} idPrefix={prefix} activeTab={section} onChange={setSection}
      tabs={[{ id: 'body', label: t('mockServers.route.bodyTab') }, { id: 'headers', label: t('mockServers.route.headersTab'), badge: response.headers.length }, { id: 'rules', label: t('mockServers.route.rulesTab'), badge: response.condition?.conditions.length }]}
    />
    <div className={section === 'body' ? 'mock-response-content' : 'mock-response-content mock-response-content--grow'} role="tabpanel" id={'tabpanel-' + prefix + section} aria-labelledby={'tab-' + prefix + section}>
      {section === 'body' ? <><div className="mock-response-content__hint"><span>{t('mockServers.route.responseBody')}</span><code>{contentType || t('mockServers.route.plainText')}</code></div><div className="mock-response-code"><RequestBodyPanel key={response.id} value={response.body} language={language} label={t('mockServers.route.responseBody')} onChange={(body) => updateResponse({ ...response, body })} /></div></> : section === 'headers' ? <div className="mock-response-headers">
        <div className="mock-response-headers__heading"><span>{t('mockServers.route.headerName')}</span><span>{t('mockServers.route.headerValue')}</span><span /></div>
        {response.headers.map((header, index) => <div className="mock-response-headers__row" key={index}><Input aria-label={t('mockServers.route.headerNameAria', { number: index + 1 })} mono placeholder="content-type" value={header.name} onChange={(event) => updateResponse({ ...response, headers: response.headers.map((item, position) => position === index ? { ...item, name: event.target.value } : item) })} /><Input aria-label={t('mockServers.route.headerValueAria', { number: index + 1 })} mono placeholder="application/json" value={header.value} onChange={(event) => updateResponse({ ...response, headers: response.headers.map((item, position) => position === index ? { ...item, value: event.target.value } : item) })} /><IconButton icon={<TrashIcon size={14} />} variant="danger" label={t('mockServers.route.removeHeaderAria', { number: index + 1 })} onClick={() => updateResponse({ ...response, headers: response.headers.filter((_, position) => position !== index) })} /></div>)}
        {response.headers.length === 0 && <p className="mock-muted">{t('mockServers.route.noHeaders')}</p>}
        <Button variant="ghost" onClick={() => updateResponse({ ...response, headers: [...response.headers, { name: '', value: '' }] })}><PlusIcon size={14} />{t('mockServers.route.addHeader')}</Button>
      </div> : conditional ? <div className="mock-response-rules">
        <div className="mock-response-rules__toolbar">
          <p>{t('mockServers.route.firstMatchWins')}</p>
          <SegmentedControl<RulesMode>
            layout="inline" size="sm" ariaLabel={t('mockServers.route.rulesModeAria')} value={mode} onChange={changeRulesMode}
            options={[{ value: 'visual', label: t('mockServers.route.rulesVisual'), disabled: invalidJson }, { value: 'json', label: t('mockServers.route.rulesJson') }]}
          />
        </div>
        {mode === 'visual'
          ? <MockRuleBuilder key={response.id} condition={response.condition} pathParameters={routePathParameters(route.path)} onChange={(condition) => updateResponse({ ...response, condition })} />
          : <>
            <div className="mock-response-code"><RequestBodyPanel key={response.id} label={t('mockServers.route.responseRules')} value={ruleDrafts[response.id] ?? (response.condition ? JSON.stringify(response.condition, null, 2) : '')} language="json" onChange={updateRules} /></div>
            {invalidJson && <p className="mock-field-error" role="alert">{t('mockServers.route.invalidRulesJson', { expected: '{ "operator": "all" | "any", "conditions": [] }' })}</p>}
          </>}
      </div> : <div className="mock-server-empty mock-server-empty--inline"><GlobeIcon size={26} /><h4>{t('mockServers.route.defaultResponseTitle')}</h4><p>{t('mockServers.route.defaultResponseHint')}</p><Button variant="ghost" onClick={addResponse}><PlusIcon size={14} />{t('mockServers.route.createConditional')}</Button></div>}
    </div>
  </section>
}
