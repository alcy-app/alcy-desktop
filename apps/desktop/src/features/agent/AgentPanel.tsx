import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { EmptyState } from '../../shared/ui/EmptyState'
import { IconButton } from '../../shared/ui/IconButton'
import { MenuItem, MenuSeparator } from '../../shared/ui/Menu'
import { useTooltip } from '../../shared/ui/use-tooltip'
import { CheckIcon, ClockIcon, CloseIcon, GearIcon, LockIcon, PlusIcon, SparkleIcon, Spinner } from '../../shared/ui/icons'
import type { WorkbenchAgentHost } from './agent-host'
import { AgentComposer } from './AgentComposer'
import { AgentHistoryPopover } from './AgentHistoryPopover'
import { AgentMessageList } from './AgentMessageList'
import { agentReferenceResolver, openAgentReference } from './agent-references'
import { quoteContext, type AgentContextOption } from './agent-context'
import { SessionTokens } from './AgentTokens'
import { useAgentSession } from './use-agent-session'
import { isProviderUsable, useAgentSettings } from './use-agent-settings'
import { useAgentApprovalMode, type AgentApprovalMode } from './use-agent-approval-mode'
import './agent.css'

const APPROVAL_MODES: AgentApprovalMode[] = ['automatic', 'autoApprove']
const APPROVAL_ICONS: Record<AgentApprovalMode, ReactNode> = { automatic: <LockIcon size={12} />, autoApprove: <CheckIcon size={12} /> }

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
  const [context, setContext] = useState<AgentContextOption[]>([])
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

  const { mode: approvalMode, setMode: setApprovalMode } = useAgentApprovalMode()
  const session = useAgentSession({
    rootPath,
    host,
    providerId: provider?.id ?? null,
    model: provider?.model ?? '',
    defaultRequestName: t('collections.newRequestName'),
    autoApprove: approvalMode === 'autoApprove',
  })
  // Rebuilt each render so names follow renames and new items while chatting.
  const resolveReference = agentReferenceResolver(host)

  const toolbar = (
    <>
      {providers.length > 0 && (
        <AgentPillPicker
          options={providers.map((candidate) => ({ id: candidate.id, label: `${candidate.label} · ${candidate.model}`, icon: <SparkleIcon size={12} /> }))}
          selectedId={provider?.id ?? null}
          triggerLabel={provider?.label ?? t('agent.chooseProvider')}
          ariaLabel={t('agent.providerAria')}
          tooltip={provider ? `${provider.label} · ${provider.model}` : t('agent.chooseProvider')}
          disabled={session.running}
          action={{ label: t('agent.configureProviders'), onSelect: onOpenSettings }}
          onSelect={(id) => void setActiveProvider(id)}
        />
      )}
      <AgentPillPicker
        options={APPROVAL_MODES.map((mode) => ({
          id: mode,
          label: t(`agent.approvalMode.${mode}`),
          icon: APPROVAL_ICONS[mode],
          detail: t(`agent.approvalMode.${mode}Detail`),
        }))}
        selectedId={approvalMode}
        triggerLabel={t(`agent.approvalMode.${approvalMode}`)}
        ariaLabel={t('agent.approvalMode.aria')}
        tooltip={t(`agent.approvalMode.${approvalMode}Detail`)}
        disabled={provider === null}
        tone={approvalMode === 'autoApprove' ? 'warning' : undefined}
        onSelect={(mode) => setApprovalMode(mode as AgentApprovalMode)}
      />
    </>
  )

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
        <AgentMessageList
          items={session.items}
          running={session.running}
          onApprove={session.approve}
          onDecline={session.decline}
          onRevert={session.revert}
          onRetry={session.retry}
          onEditLast={session.editLast}
          onFollowUp={(text) => {
            void session.send(text, [])
            composerRef.current?.focus()
          }}
          onQuote={(text, label, kind) => {
            setContext((current) => [...current, quoteContext(text, label, kind)])
            composerRef.current?.focus()
          }}
          onOpenReference={(kind, id) => openAgentReference(host, kind, id)}
          resolveReference={resolveReference}
        />
      )}

      {session.tokens.input + session.tokens.output > 0 && <SessionTokens tokens={session.tokens} />}

      <AgentComposer
        host={host}
        text={draft}
        onTextChange={setDraft}
        context={context}
        onContextChange={setContext}
        textareaRef={composerRef}
        running={session.running}
        disabled={provider === null}
        footer={toolbar}
        onSend={(text, context) => void session.send(text, context)}
        onStop={session.stop}
      />
    </aside>
  )
}

interface PillOption {
  id: string
  label: string
  icon: ReactNode
  /** Shown on hover (e.g. what an approval mode does). */
  detail?: string
}

interface AgentPillPickerProps {
  options: PillOption[]
  selectedId: string | null
  /** Text of the trigger. */
  triggerLabel: string
  /** Accessible name of the trigger and title of the menu. */
  ariaLabel: string
  tooltip: string
  disabled: boolean
  /** Marks the trigger, e.g. `warning` while auto-approval is on. */
  tone?: 'warning'
  /** Item after a separator at the end of the menu. */
  action?: { label: string; onSelect: () => void }
  onSelect: (id: string) => void
}

/** Compact pill trigger in the composer toolbar with a menu of options. */
function AgentPillPicker({ options, selectedId, triggerLabel, ariaLabel, tooltip: tooltipText, disabled, tone, action, onSelect }: AgentPillPickerProps) {
  const [open, setOpen] = useState(false)
  // WebKitGTK applies :focus-visible to pointer-driven focus, so the picker
  // tracks the last interaction and draws the ring only for the keyboard.
  const [pointerInteraction, setPointerInteraction] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const { triggerProps, tooltip } = useTooltip(tooltipText, { side: 'top', enabled: !open })

  if (disabled && open) setOpen(false)

  useEffect(() => {
    if (!open) return
    const selected = menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
    const first = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')
    const target = selected ?? first
    target?.focus()
  }, [open])

  // Clicking elsewhere closes the menu and drops the focus restored to the trigger,
  // so the focus ring and its tooltip do not linger after the pointer leaves.
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
      setPointerInteraction(false)
      const active = document.activeElement
      if (active instanceof HTMLElement && rootRef.current?.contains(active)) active.blur()
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [])

  // Focus returns to the trigger only after a keyboard choice; moved by script
  // after a mouse click, it would leave the focus ring behind.
  const close = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) buttonRef.current?.focus()
  }

  return (
    <div
      ref={rootRef}
      className="agent-provider-picker"
      data-pointer-interaction={pointerInteraction || undefined}
      onPointerDown={() => setPointerInteraction(true)}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setOpen(false)
        setPointerInteraction(false)
      }}
      onKeyDown={(event) => {
        setPointerInteraction(false)
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          event.stopPropagation()
          close(true)
          return
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || disabled) return
        event.preventDefault()
        if (!open) {
          setOpen(true)
          return
        }
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]') ?? [])
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
        data-tone={tone}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        {...triggerProps}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="agent-provider-trigger-icon" aria-hidden="true">{options.find((option) => option.id === selectedId)?.icon}</span>
        <span className="agent-provider-label">{triggerLabel}</span>
      </Button>
      {tooltip}
      {open && (
        <div ref={menuRef} id={menuId} className="ui-menu agent-provider-menu" role="menu" aria-label={ariaLabel}>
          {options.map((option) => (
            <div key={option.id} className="agent-provider-option" title={option.detail}>
              <MenuItem
                label={option.label}
                icon={option.icon}
                selected={option.id === selectedId}
                onSelect={() => {
                  onSelect(option.id)
                  close(!pointerInteraction)
                }}
              />
            </div>
          ))}
          {action && (
            <>
              <MenuSeparator />
              <div className="agent-provider-option">
                <MenuItem
                  label={action.label}
                  onSelect={() => {
                    setOpen(false)
                    action.onSelect()
                  }}
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
