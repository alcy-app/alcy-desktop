import { useEffect, useId, useRef, useState } from 'react'
import type { AgentProviderDto } from '../../bindings/agent-settings'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { EmptyState } from '../../shared/ui/EmptyState'
import { IconButton } from '../../shared/ui/IconButton'
import { MenuItem } from '../../shared/ui/Menu'
import { useTooltip } from '../../shared/ui/use-tooltip'
import { CheckIcon, ChevronDownIcon, ClockIcon, CloseIcon, GearIcon, PlusIcon, SparkleIcon, Spinner } from '../../shared/ui/icons'
import type { WorkbenchAgentHost } from './agent-host'
import { AgentComposer } from './AgentComposer'
import { AgentHistoryPopover } from './AgentHistoryPopover'
import { AgentMessageList } from './AgentMessageList'
import { useAgentSession } from './use-agent-session'
import { isProviderUsable, useAgentSettings } from './use-agent-settings'
import './agent.css'

interface AgentPanelProps {
  rootPath: string
  host: WorkbenchAgentHost
  /** Settings are open: the panel reloads the providers when they close. */
  settingsOpen: boolean
  onOpenSettings: () => void
  onClose: () => void
}

/** Chat with the agent, docked to the right of the workbench (ADR 0064). */
export function AgentPanel({ rootPath, host, settingsOpen, onOpenSettings, onClose }: AgentPanelProps) {
  const { t } = useLanguage()
  const { state, reload, setActiveProvider } = useAgentSettings()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const historyButtonRef = useRef<HTMLButtonElement>(null)

  const closeHistory = () => {
    setHistoryOpen(false)
    historyButtonRef.current?.focus()
  }

  const wasSettingsOpen = useRef(settingsOpen)
  useEffect(() => {
    if (wasSettingsOpen.current && !settingsOpen) void reload()
    wasSettingsOpen.current = settingsOpen
  }, [reload, settingsOpen])

  const providers = state.status === 'ready' ? state.settings.providers.filter(isProviderUsable) : []
  const activeId = state.status === 'ready' ? state.settings.activeProviderId : null
  const provider = providers.find((candidate) => candidate.id === activeId) ?? null

  const session = useAgentSession({
    rootPath,
    host,
    providerId: provider?.id ?? null,
    model: provider?.model ?? '',
    defaultRequestName: t('collections.newRequestName'),
  })

  const providerPicker =
    providers.length > 0 ? (
      <AgentProviderPicker
        providers={providers}
        provider={provider}
        disabled={session.running}
        onSelect={(id) => void setActiveProvider(id)}
      />
    ) : null

  return (
    <aside className="agent-panel" aria-label={t('agent.title')}>
      <header className="agent-panel-header">
        <h2 className="agent-panel-title" title={session.title ?? undefined}>
          {session.title ?? t('agent.newChat')}
        </h2>
        <div className="agent-panel-actions">
          <IconButton icon={<PlusIcon size={13} />} label={t('agent.newChat')} disabled={session.running} onClick={session.newChat} />
          <IconButton
            ref={historyButtonRef}
            icon={<ClockIcon size={13} />}
            label={t('agent.history.title')}
            aria-expanded={historyOpen}
            disabled={session.running}
            onClick={() => setHistoryOpen((open) => !open)}
          />
          <IconButton icon={<GearIcon size={13} />} label={t('agent.settings')} onClick={onOpenSettings} />
          <IconButton icon={<CloseIcon size={13} />} label={t('agent.close')} onClick={onClose} />
        </div>
        {historyOpen && (
          <AgentHistoryPopover
            rootPath={rootPath}
            activeSessionId={session.sessionId}
            triggerRef={historyButtonRef}
            onClose={closeHistory}
            onDeleted={() => {}}
            onOpen={(id) => {
              setHistoryOpen(false)
              void session.openSession(id)
              composerRef.current?.focus()
            }}
          />
        )}
      </header>

      {state.status === 'loading' ? (
        <div className="agent-panel-placeholder">
          <Spinner size={14} />
        </div>
      ) : provider === null ? (
        <div className="agent-panel-placeholder agent-panel-setup">
          <EmptyState
            icon={<SparkleIcon size={20} />}
            title={t('agent.setup.title')}
            description={state.status === 'error' ? state.message : providers.length > 0 ? t('agent.setup.choose') : t('agent.setup.description')}
            action={providers.length === 0 && <Button onClick={onOpenSettings}>{t('agent.setup.action')}</Button>}
          />
        </div>
      ) : session.items.length === 0 ? (
        <div className="agent-panel-placeholder agent-panel-welcome">
          <EmptyState icon={<SparkleIcon size={20} />} title={t('agent.empty.title')} description={t('agent.empty.description')} />
          <div className="agent-suggestions" aria-label={t('agent.suggestions.aria')}>
            {(['create', 'explain', 'auth'] as const).map((suggestion) => (
              <Button key={suggestion} variant="ghost" className="agent-suggestion" onClick={() => {
                setDraft(t(`agent.suggestions.${suggestion}`))
                composerRef.current?.focus()
              }}>
                {t(`agent.suggestions.${suggestion}`)}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <AgentMessageList items={session.items} onApprove={session.approve} onDecline={session.decline} onRevert={session.revert} />
      )}

      <AgentComposer
        host={host}
        text={draft}
        onTextChange={setDraft}
        textareaRef={composerRef}
        running={session.running}
        disabled={provider === null}
        footer={providerPicker}
        onSend={(text, context) => void session.send(text, context)}
        onStop={session.stop}
      />
    </aside>
  )
}

interface AgentProviderPickerProps {
  providers: AgentProviderDto[]
  provider: AgentProviderDto | null
  disabled: boolean
  onSelect: (id: string) => void
}

/** Compact provider trigger; the menu keeps full model names readable. */
function AgentProviderPicker({ providers, provider, disabled, onSelect }: AgentProviderPickerProps) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const { triggerProps, tooltip } = useTooltip(
    provider ? `${provider.label} · ${provider.model}` : t('agent.chooseProvider'),
    { side: 'top', enabled: !open },
  )

  if (disabled && open) setOpen(false)

  useEffect(() => {
    if (!open) return
    const selected = menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
    const first = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')
    const target = selected ?? first
    target?.focus()
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  const close = () => {
    setOpen(false)
    buttonRef.current?.focus()
  }

  return (
    <div
      ref={rootRef}
      className="agent-provider-picker"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          event.stopPropagation()
          close()
          return
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || disabled) return
        event.preventDefault()
        if (!open) {
          setOpen(true)
          return
        }
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])
        if (items.length === 0) return
        const current = items.findIndex((item) => item === document.activeElement)
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items[index]?.focus()
        items[index]?.scrollIntoView?.({ block: 'nearest' })
      }}
    >
      <Button
        ref={buttonRef}
        variant="ghost"
        className="agent-provider-trigger"
        aria-label={t('agent.providerAria')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        {...triggerProps}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="agent-provider-label">{provider?.label ?? t('agent.chooseProvider')}</span>
        <ChevronDownIcon size={10} />
      </Button>
      {tooltip}
      {open && (
        <div ref={menuRef} id={menuId} className="ui-menu agent-provider-menu" role="menu" aria-label={t('agent.providerAria')}>
          <p className="agent-provider-menu-title">{t('agent.providerAria')}</p>
          {providers.map((candidate) => (
            <div key={candidate.id} className="agent-provider-option">
              <MenuItem
                label={`${candidate.label} · ${candidate.model}`}
                icon={candidate.id === provider?.id ? <CheckIcon size={12} /> : <span />}
                selected={candidate.id === provider?.id}
                onSelect={() => {
                  onSelect(candidate.id)
                  close()
                }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
