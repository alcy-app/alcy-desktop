import { useEffect, useId, useState } from 'react'
import {
  clearAgentApiKey,
  getAgentSettings,
  listAgentModels,
  saveAgentSettings,
  setAgentApiKey,
  type AgentModelDto,
  type AgentProviderDto,
  type AgentProviderKind,
  type AgentSettingsDto,
} from '../../bindings/agent-settings'
import type { TranslationKey } from '../../shared/i18n/translations'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Checkbox } from '../../shared/ui/Checkbox'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { Input } from '../../shared/ui/Input'
import { AlertIcon, CheckIcon, ChevronDownIcon, LockIcon, PlusIcon, SparkleIcon } from '../../shared/ui/icons'
import { agentErrorMessage } from '../agent/use-agent-session'
import { providerInput } from '../agent/use-agent-settings'
import { useAgentPreferences } from '../agent/use-agent-preferences'
import { ModelCombobox } from './ModelCombobox'

/** Same limit as the backend (`MAX_AGENT_PROVIDERS`). */
const MAX_PROVIDERS = 16
type PresetKey = 'claude' | 'opencode' | 'openrouter' | 'ollama' | 'lmstudio' | 'openaiCompatible'

interface ProviderPreset {
  key: PresetKey
  kind: AgentProviderKind
  /** Product names stay as they are; the generic one is translated. */
  label: string | null
  baseUrl: string
  model: string
}

/** Every provider starts from one of these; none is set up until the user adds it. */
const PRESETS: ProviderPreset[] = [
  { key: 'claude', kind: 'anthropic', label: 'Claude', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' },
  { key: 'opencode', kind: 'openaiCompatible', label: 'OpenCode Zen', baseUrl: 'https://opencode.ai/inference/openai/v1', model: 'claude-sonnet-5-5' },
  { key: 'openrouter', kind: 'openaiCompatible', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  { key: 'ollama', kind: 'openaiCompatible', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: '' },
  { key: 'lmstudio', kind: 'openaiCompatible', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', model: '' },
  { key: 'openaiCompatible', kind: 'openaiCompatible', label: null, baseUrl: 'http://localhost:8000/v1', model: '' },
]

type ProviderStatus = 'ready' | 'needsKey' | 'needsModel'

function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.|\[::1\])/i.test(url.trim())
}

/** What is still missing for the chat to use the provider. */
function providerStatus(provider: AgentProviderDto): ProviderStatus {
  if (provider.model.trim() === '') return 'needsModel'
  const keyRequired = provider.kind === 'anthropic' || !isLocalUrl(provider.baseUrl)
  return keyRequired && !provider.hasApiKey ? 'needsKey' : 'ready'
}

function uniqueId(base: string, providers: AgentProviderDto[]): string {
  const taken = new Set(providers.map((provider) => provider.id))
  if (!taken.has(base)) return base
  let index = 2
  while (taken.has(`${base}-${index}`)) index += 1
  return `${base}-${index}`
}

type SaveResult = { ok: boolean }

/** Agent providers (ADR 0064): which one the chat uses and how each connects. Keys stay in the system keyring. */
export function AgentSection() {
  const { t } = useLanguage()
  const { chatEnabled, contextOptionsDisabled, setChatEnabled, setContextOptionsDisabled } = useAgentPreferences()
  const [settings, setSettings] = useState<AgentSettingsDto | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getAgentSettings().then((result) => {
      if (cancelled) return
      if (!result.ok) {
        setLoadError(agentErrorMessage(result.error, t))
        return
      }
      setSettings(result.value)
      // Open the provider in use, or the first one still to be set up.
      const active = result.value.providers.find((provider) => provider.id === result.value.activeProviderId)
      setExpandedId(active?.id ?? result.value.providers.find((provider) => providerStatus(provider) !== 'ready')?.id ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [t])

  const save = async (providers: AgentProviderDto[], activeProviderId: string | null): Promise<SaveResult> => {
    const result = await saveAgentSettings({
      providers: providers.map(providerInput),
      activeProviderId,
    })
    if (result.ok) setSettings(result.value)
    return result
  }

  const reload = async () => {
    const result = await getAgentSettings()
    if (result.ok) setSettings(result.value)
  }

  const addPreset = async (preset: ProviderPreset) => {
    if (!settings) return
    setAddError(null)
    const provider: AgentProviderDto = {
      id: uniqueId(preset.key.toLowerCase(), settings.providers),
      kind: preset.kind,
      label: preset.label ?? t('settings.agent.preset.openaiCompatible'),
      baseUrl: preset.baseUrl,
      model: preset.model,
      hasApiKey: false,
    }
    const result = await save([...settings.providers, provider], settings.activeProviderId)
    if (!result.ok) {
      setAddError(t('settings.agent.addError'))
      return
    }
    setAdding(false)
    setExpandedId(provider.id)
  }

  const remove = async (provider: AgentProviderDto): Promise<SaveResult> => {
    if (!settings) return { ok: false }
    // The key goes first: a provider removed from the list could not be reached to remove it later.
    if (provider.hasApiKey) {
      const cleared = await clearAgentApiKey(provider.id)
      if (!cleared.ok) return { ok: false }
    }
    const active = settings.activeProviderId === provider.id ? null : settings.activeProviderId
    return save(settings.providers.filter((candidate) => candidate.id !== provider.id), active)
  }

  return (
    <div className="settings-agent">
      <section className="settings-section settings-agent-preferences">
        <div>
          <label className="settings-checkbox">
            <Checkbox checked={chatEnabled} onChange={(event) => setChatEnabled(event.target.checked)} />
            <span>{t('settings.agent.enableChat')}</span>
          </label>
          <p className="settings-proxy-hint">{t('settings.agent.enableChatHint')}</p>
        </div>
        <div>
          <label className="settings-checkbox">
            <Checkbox checked={contextOptionsDisabled} onChange={(event) => setContextOptionsDisabled(event.target.checked)} />
            <span>{t('settings.agent.disableContextOptions')}</span>
          </label>
          <p className="settings-proxy-hint">{t('settings.agent.disableContextOptionsHint')}</p>
        </div>
      </section>
      <section className="settings-section settings-agent-intro">
        <div>
          <p className="settings-section-label">{t('settings.agent.title')}</p>
          <p className="settings-proxy-hint">{t('settings.agent.subtitle')}</p>
        </div>
        <details className="settings-agent-privacy">
          <summary>{t('settings.agent.privacyTitle')}</summary>
          <p>{t('settings.agent.privacy')}</p>
        </details>
        {loadError && <InlineAlert>{loadError}</InlineAlert>}
      </section>

      {settings && settings.providers.length === 0 && !adding && (
        <p className="settings-agent-empty">{t('settings.agent.empty')}</p>
      )}

      {settings && settings.providers.length > 0 && (
        <ul className="settings-agent-list" aria-label={t('settings.agent.listAria')}>
          {settings.providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              active={settings.activeProviderId === provider.id}
              expanded={expandedId === provider.id}
              onToggle={() => setExpandedId((current) => (current === provider.id ? null : provider.id))}
              onSave={(next) => save(settings.providers.map((candidate) => (candidate.id === next.id ? next : candidate)), settings.activeProviderId)}
              onActivate={() => save(settings.providers, provider.id)}
              onRemove={() => remove(provider)}
              onKeyChanged={reload}
            />
          ))}
        </ul>
      )}

      {settings && settings.providers.length < MAX_PROVIDERS && (
        <section className="settings-agent-add">
          {adding ? (
            <>
              <div className="settings-agent-add-header">
                <p className="settings-section-label">{t('settings.agent.addTitle')}</p>
                <Button variant="ghost" onClick={() => setAdding(false)}>{t('settings.agent.cancel')}</Button>
              </div>
              <div className="settings-agent-presets">
                {PRESETS.map((preset) => (
                  <button key={preset.key} type="button" className="settings-agent-preset" onClick={() => void addPreset(preset)}>
                    <span className="settings-agent-preset-name">{preset.label ?? t('settings.agent.preset.openaiCompatible')}</span>
                    <span className="settings-agent-preset-detail">{t(`settings.agent.preset.${preset.key}Detail` as TranslationKey)}</span>
                  </button>
                ))}
              </div>
              {addError && <InlineAlert>{addError}</InlineAlert>}
            </>
          ) : (
            <Button variant="ghost" className="settings-agent-add-button" onClick={() => setAdding(true)}>
              <PlusIcon size={12} />
              {t('settings.agent.add')}
            </Button>
          )}
        </section>
      )}
    </div>
  )
}

interface ProviderCardProps {
  provider: AgentProviderDto
  active: boolean
  expanded: boolean
  onToggle: () => void
  onSave: (provider: AgentProviderDto) => Promise<SaveResult>
  onActivate: () => Promise<SaveResult>
  onRemove: () => Promise<SaveResult>
  onKeyChanged: () => Promise<void>
}

type Busy = 'save' | 'key' | 'test' | 'remove' | null
type TestResult = { ok: true; count: number } | { ok: false; message: string } | null

function ProviderCard({ provider, active, expanded, onToggle, onSave, onActivate, onRemove, onKeyChanged }: ProviderCardProps) {
  const { t } = useLanguage()
  const id = useId()
  const [label, setLabel] = useState(provider.label)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [model, setModel] = useState(provider.model)
  const [apiKey, setApiKey] = useState('')
  const [replacingKey, setReplacingKey] = useState(false)
  const [models, setModels] = useState<AgentModelDto[]>([])
  const [testResult, setTestResult] = useState<TestResult>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  const status = providerStatus(provider)
  const dirty = label.trim() !== provider.label || baseUrl.trim() !== provider.baseUrl || model.trim() !== provider.model
  const local = isLocalUrl(provider.baseUrl)
  const keyOptional = provider.kind === 'openaiCompatible' && local
  const editingKey = !provider.hasApiKey || replacingKey

  const run = async (kind: Busy, action: () => Promise<void>) => {
    setBusy(kind)
    setError(null)
    setSaved(false)
    try {
      await action()
    } finally {
      setBusy(null)
    }
  }

  const saveFields = () =>
    run('save', async () => {
      const result = await onSave({ ...provider, label: label.trim() || provider.label, baseUrl: baseUrl.trim(), model: model.trim() })
      if (result.ok) setSaved(true)
      else setError(t('settings.agent.saveError'))
    })

  const storeKey = () =>
    run('key', async () => {
      const result = await setAgentApiKey(provider.id, apiKey)
      if (!result.ok) {
        setError(agentErrorMessage(result.error, t))
        return
      }
      setApiKey('')
      setReplacingKey(false)
      setTestResult(null)
      await onKeyChanged()
    })

  const removeKey = () =>
    run('key', async () => {
      const result = await clearAgentApiKey(provider.id)
      if (!result.ok) {
        setError(agentErrorMessage(result.error, t))
        return
      }
      setTestResult(null)
      await onKeyChanged()
    })

  const test = () =>
    run('test', async () => {
      const result = await listAgentModels(provider.id)
      if (!result.ok) {
        setTestResult({ ok: false, message: agentErrorMessage(result.error, t) })
        return
      }
      setModels(result.value)
      setTestResult({ ok: true, count: result.value.length })
    })

  const remove = () =>
    run('remove', async () => {
      const result = await onRemove()
      if (!result.ok) setError(t('settings.agent.removeError'))
    })

  return (
    <li className="settings-agent-card" data-active={active} data-expanded={expanded}>
      <button type="button" className="settings-agent-card-header" aria-expanded={expanded} aria-controls={`${id}-body`} onClick={onToggle}>
        <span className="settings-agent-card-icon" aria-hidden="true"><SparkleIcon size={14} /></span>
        <span className="settings-agent-card-title">
          <span className="settings-agent-card-name">{provider.label}</span>
          <span className="settings-agent-card-meta">
            {t(provider.kind === 'anthropic' ? 'settings.agent.badge.anthropic' : 'settings.agent.badge.openaiCompatible')}
            {' · '}
            {provider.model || t('settings.agent.noModel')}
          </span>
        </span>
        {active && <span className="settings-agent-pill" data-tone="accent">{t('settings.agent.active')}</span>}
        <span className="settings-agent-pill" data-tone={status === 'ready' ? 'success' : 'warning'}>
          {status === 'ready' ? <CheckIcon size={10} /> : <AlertIcon size={10} />}
          {t(`settings.agent.status.${status}`)}
        </span>
        <ChevronDownIcon size={12} className="settings-agent-card-chevron" />
      </button>

      {expanded && (
        <div id={`${id}-body`} className="settings-agent-card-body">
          <p className="settings-proxy-hint">{t(provider.kind === 'anthropic' ? 'settings.agent.kind.anthropic' : 'settings.agent.kind.openaiCompatible')}</p>

          <div className="settings-agent-fields">
            <label className="settings-agent-field">
              <span>{t('settings.agent.name')}</span>
              <Input value={label} onChange={(event) => setLabel(event.target.value)} />
            </label>
            <label className="settings-agent-field">
              <span>{t('settings.agent.baseUrl')}</span>
              <Input mono value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
            </label>
            <div className="settings-agent-field">
              <span>{t('settings.agent.model')}</span>
              <ModelCombobox
                value={model}
                onChange={setModel}
                models={models}
                loading={busy === 'test'}
                canLoad={!dirty && busy === null}
                onLoad={() => void test()}
                label={t('settings.agent.model')}
                placeholder={t('settings.agent.modelPlaceholder')}
              />
            </div>
          </div>

          <div className="settings-agent-key">
            <span className="settings-agent-key-title">{t('settings.agent.apiKey')}</span>
            {editingKey ? (
              <div className="settings-agent-key-row">
                <Input
                  type="password"
                  autoComplete="off"
                  aria-label={t('settings.agent.apiKey')}
                  value={apiKey}
                  placeholder={keyOptional ? t('settings.agent.keyOptionalPlaceholder') : t('settings.agent.keyPlaceholder')}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <Button isLoading={busy === 'key'} disabled={busy !== null || apiKey.trim() === ''} onClick={() => void storeKey()}>
                  {t('settings.agent.saveKey')}
                </Button>
                {replacingKey && (
                  <Button variant="ghost" disabled={busy !== null} onClick={() => setReplacingKey(false)}>
                    {t('settings.agent.cancel')}
                  </Button>
                )}
              </div>
            ) : (
              <div className="settings-agent-key-row settings-agent-key-stored">
                <LockIcon size={12} />
                <span>{t('settings.agent.keyStored')}</span>
                <Button variant="ghost" disabled={busy !== null} onClick={() => setReplacingKey(true)}>
                  {t('settings.agent.replaceKey')}
                </Button>
                <Button variant="ghost" isLoading={busy === 'key'} disabled={busy !== null} onClick={() => void removeKey()}>
                  {t('settings.agent.removeKey')}
                </Button>
              </div>
            )}
          </div>

          <div className="settings-agent-test">
            <Button variant="ghost" isLoading={busy === 'test'} disabled={busy !== null || dirty} onClick={() => void test()}>
              {t('settings.agent.test')}
            </Button>
            {dirty ? (
              <span className="settings-agent-test-result">{t('settings.agent.testAfterSave')}</span>
            ) : (
              testResult && (
                <span className="settings-agent-test-result" data-ok={testResult.ok} role="status">
                  {testResult.ok ? <CheckIcon size={12} /> : <AlertIcon size={12} />}
                  {testResult.ok ? t('settings.agent.testOk', { count: testResult.count }) : testResult.message}
                </span>
              )
            )}
          </div>

          {error && <InlineAlert>{error}</InlineAlert>}

          <div className="settings-agent-card-footer">
            {confirmingRemove ? (
              <>
                <Button variant="danger" isLoading={busy === 'remove'} disabled={busy !== null} onClick={() => void remove()}>
                  {t('settings.agent.confirmRemove')}
                </Button>
                <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirmingRemove(false)}>
                  {t('settings.agent.cancel')}
                </Button>
              </>
            ) : (
              <Button variant="ghost" className="settings-agent-remove" disabled={busy !== null} onClick={() => setConfirmingRemove(true)}>
                {t('settings.agent.remove')}
              </Button>
            )}
            <span className="settings-agent-card-footer-spacer" />
            {saved && !dirty && (
              <span className="settings-agent-saved" role="status">
                <CheckIcon size={12} />
                {t('settings.agent.saved')}
              </span>
            )}
            {!active && (
              <Button variant="ghost" disabled={dirty || busy !== null} onClick={() => void onActivate()}>
                {t('settings.agent.useInChat')}
              </Button>
            )}
            <Button isLoading={busy === 'save'} disabled={busy !== null || !dirty} onClick={() => void saveFields()}>
              {t('settings.agent.save')}
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}
