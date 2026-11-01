import { useCallback, useEffect, useState } from 'react'
import { listMockServers, saveMockServer, type MockServerSummaryDto } from '../../bindings/mock-servers'
import { useLanguage } from '../../shared/i18n/use-language'
import { MockServerIcon, PlusIcon, RefreshIcon } from '../../shared/ui/icons'
import { MentionInChatMenuItem } from '../agent/MentionInChatMenuItem'
import { useAgentPreferences } from '../agent/use-agent-preferences'
import { TabMenuSurface } from '../request-workbench/components/TabMenuSurface'
import { MOCK_SERVERS_CHANGED_EVENT, mockErrorMessage, newMockServer } from './mock-server-defaults'
import './mock-servers.css'

interface MockServersPanelProps {
  rootPath: string
  activeServerId: string | null
  onOpenServer: (serverId: string, label: string) => void
}

export function MockServersPanel({ rootPath, activeServerId, onOpenServer }: MockServersPanelProps) {
  const { t } = useLanguage()
  const { contextOptionsEnabled } = useAgentPreferences()
  const [summaries, setSummaries] = useState<MockServerSummaryDto[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ server: MockServerSummaryDto; x: number; y: number } | null>(null)
  const refresh = useCallback(async () => {
    const result = await listMockServers(rootPath)
    if (result.ok) setSummaries(result.value.servers)
    else setMessage(mockErrorMessage(result.error, t))
  }, [rootPath, t])
  useEffect(() => {
    let cancelled = false
    void listMockServers(rootPath).then((result) => {
      if (cancelled) return
      if (result.ok) setSummaries(result.value.servers)
      else setMessage(mockErrorMessage(result.error, t))
    })
    const handleChanged = () => { void refresh() }
    window.addEventListener(MOCK_SERVERS_CHANGED_EVENT, handleChanged)
    return () => { cancelled = true; window.removeEventListener(MOCK_SERVERS_CHANGED_EVENT, handleChanged) }
  }, [refresh, rootPath, t])
  const create = async () => {
    const server = newMockServer(Math.max(3000, ...summaries.map((item) => item.port)) + 1, t)
    const result = await saveMockServer(rootPath, server)
    if (!result.ok) { setMessage(mockErrorMessage(result.error, t)); return }
    await refresh()
    onOpenServer(server.id, server.name)
  }
  return <section className="mock-server-browser sidebar-panel-layout" aria-label={t('mockServers.title')}>
    <div className="mock-server-browser__toolbar sidebar-panel-toolbar">
      <button type="button" className="mock-server-browser__new" onClick={() => void create()}><PlusIcon size={14} />{t('mockServers.panel.new')}</button>
      <button type="button" className="mock-server-browser__refresh" aria-label={t('mockServers.panel.refresh')} onClick={() => void refresh()}><RefreshIcon size={14} /></button>
    </div>
    {message && <p className="mock-server-browser__message" role="status">{message}</p>}
    <div className="mock-server-browser__list sidebar-panel-scroll">
      {summaries.length === 0 && <div className="mock-server-browser__empty"><MockServerIcon size={28} /><strong>{t('mockServers.panel.empty')}</strong></div>}
      {summaries.map((server) => <button type="button" className="mock-server-browser__item" key={server.id} aria-current={server.id === activeServerId ? 'page' : undefined} onClick={() => onOpenServer(server.id, server.name)} onContextMenu={contextOptionsEnabled ? (event) => { event.preventDefault(); setMenu({ server, x: event.clientX, y: event.clientY }) } : undefined}>
        <span className={server.running ? 'mock-server-browser__status mock-server-browser__status--running' : 'mock-server-browser__status'} />
        <span className="mock-server-browser__item-copy"><strong>{server.name}</strong><small>localhost:{server.port} · {t(server.routesCount === 1 ? 'mockServers.panel.routeCountOne' : 'mockServers.panel.routeCount', { count: server.routesCount })}</small></span>
      </button>)}
    </div>
    {contextOptionsEnabled && menu && (
      <TabMenuSurface x={menu.x} y={menu.y} label={t('mockServers.panel.contextMenuAria', { name: menu.server.name })} onClose={() => setMenu(null)}>
        <MentionInChatMenuItem item={{ kind: 'mock', id: menu.server.id, label: menu.server.name }} onDone={() => setMenu(null)} />
      </TabMenuSurface>
    )}
  </section>
}
