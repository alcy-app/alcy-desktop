import { useEffect, useId, useState } from 'react'
import {
  clearAgentApiKey,
  getAgentSettings,
  listAgentModels,
  saveAgentSettings,
  setAgentApiKey,
  type AgentModelDto,
  type AgentProviderDto,
  type AgentSettingsDto,
} from '../../bindings/agent-settings'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { Input } from '../../shared/ui/Input'
import { CheckIcon } from '../../shared/ui/icons'
import { agentErrorMessage } from '../agent/use-agent-session'

type Feedback = { kind: 'ok' | 'error'; message: string } | null

/** Agent providers (ADR 0064): base URL, default model and the API key, kept in the system keyring. */
export function AgentSection() {
  const { t } = useLanguage()
  const [settings, setSettings] = useState<AgentSettingsDto | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getAgentSettings().then((result) => {
      if (cancelled) return
      if (result.ok) setSettings(result.value)
      else setLoadError(agentErrorMessage(result.error, t))
    })
    return () => {
      cancelled = true
    }
  }, [t])

  const save = async (providers: AgentProviderDto[], activeProviderId: string | null) => {
    const result = await saveAgentSettings({
      providers: providers.map(({ id, kind, label, baseUrl, model }) => ({ id, kind, label, baseUrl, model })),
      activeProviderId,
    })
    if (result.ok) setSettings(result.value)
    return result
  }

  return (
    <>
      <section className="settings-section">
        <p className="settings-section-label">{t('settings.agent.title')}</p>
        <p className="settings-proxy-hint">{t('settings.agent.privacy')}</p>
        {loadError && <InlineAlert>{loadError}</InlineAlert>}
      </section>
      {settings?.providers.map((provider) => (
        <ProviderSettings
          key={provider.id}
          provider={provider}
          active={settings.activeProviderId === provider.id}
          onSave={(next) => save(settings.providers.map((candidate) => (candidate.id === next.id ? next : candidate)), settings.activeProviderId)}
          onActivate={() => save(settings.providers, provider.id)}
          onKeyChanged={async () => {
            const result = await getAgentSettings()
            if (result.ok) setSettings(result.value)
          }}
        />
      ))}
    </>
  )
}

interface ProviderSettingsProps {
  provider: AgentProviderDto
  active: boolean
  onSave: (provider: AgentProviderDto) => Promise<{ ok: boolean }>
  onActivate: () => Promise<{ ok: boolean }>
  onKeyChanged: () => Promise<void>
}

function ProviderSettings({ provider, active, onSave, onActivate, onKeyChanged }: ProviderSettingsProps) {
  const { t } = useLanguage()
  const id = useId()
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [model, setModel] = useState(provider.model)
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<AgentModelDto[]>([])
  const [busy, setBusy] = useState<'save' | 'key' | 'test' | null>(null)
  const [feedback, setFeedback] = useState<Feedback>(null)

  const dirty = baseUrl.trim() !== provider.baseUrl || model.trim() !== provider.model
  const needsKey = provider.kind === 'anthropic'

  const run = async (kind: 'save' | 'key' | 'test', action: () => Promise<Feedback>) => {
    setBusy(kind)
    setFeedback(null)
    setFeedback(await action())
    setBusy(null)
  }

  const saveFields = () =>
    run('save', async () => {
      const result = await onSave({ ...provider, baseUrl: baseUrl.trim(), model: model.trim() })
      return result.ok ? { kind: 'ok', message: t('settings.agent.saved') } : { kind: 'error', message: t('settings.agent.saveError') }
    })

  const storeKey = () =>
    run('key', async () => {
      const result = await setAgentApiKey(provider.id, apiKey)
      if (!result.ok) return { kind: 'error', message: agentErrorMessage(result.error, t) }
      setApiKey('')
      await onKeyChanged()
      return { kind: 'ok', message: t('settings.agent.keySaved') }
    })

  const removeKey = () =>
    run('key', async () => {
      const result = await clearAgentApiKey(provider.id)
      if (!result.ok) return { kind: 'error', message: agentErrorMessage(result.error, t) }
      await onKeyChanged()
      return { kind: 'ok', message: t('settings.agent.keyRemoved') }
    })

  const test = () =>
    run('test', async () => {
      const result = await listAgentModels(provider.id)
      if (!result.ok) return { kind: 'error', message: agentErrorMessage(result.error, t) }
      setModels(result.value)
      return { kind: 'ok', message: t('settings.agent.testOk', { count: result.value.length }) }
    })

  return (
    <section className="settings-section settings-agent-provider" data-active={active} aria-labelledby={`${id}-title`}>
      <div className="settings-agent-provider-header">
        <div className="settings-agent-provider-name">
          <p id={`${id}-title`} className="settings-section-label">
            {provider.label}
          </p>
          <span className="settings-agent-kind">{t(provider.kind === 'anthropic' ? 'settings.agent.badge.anthropic' : 'settings.agent.badge.openaiCompatible')}</span>
        </div>
        {active ? (
          <span className="settings-agent-active">
            <CheckIcon size={12} />
            {t('settings.agent.active')}
          </span>
        ) : (
          <Button variant="ghost" disabled={dirty || busy !== null} onClick={() => void onActivate()}>
            {t('settings.agent.useInChat')}
          </Button>
        )}
      </div>
      <p className="settings-proxy-hint">{t(provider.kind === 'anthropic' ? 'settings.agent.kind.anthropic' : 'settings.agent.kind.openaiCompatible')}</p>
      <div className="settings-agent-fields">
        <label className="settings-agent-field">
          <span>{t('settings.agent.baseUrl')}</span>
          <Input mono value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
        </label>
        <label className="settings-agent-field">
          <span>{t('settings.agent.model')}</span>
          <Input mono value={model} list={`${id}-models`} placeholder={t('settings.agent.modelPlaceholder')} onChange={(event) => setModel(event.target.value)} />
          <datalist id={`${id}-models`}>
            {models.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </datalist>
        </label>
        <label className="settings-agent-field settings-agent-field--key">
          <span>
            {t('settings.agent.apiKey')}
            {provider.hasApiKey && <span className="settings-agent-key-state"> · {t('settings.agent.keyStored')}</span>}
            {!provider.hasApiKey && !needsKey && <span className="settings-agent-key-state"> · {t('settings.agent.keyOptional')}</span>}
          </span>
          <Input
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder={provider.hasApiKey ? t('settings.agent.keyReplacePlaceholder') : t('settings.agent.keyPlaceholder')}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
      </div>
      <div className="settings-agent-actions">
        <Button variant="ghost" isLoading={busy === 'test'} disabled={busy !== null || dirty} onClick={() => void test()}>
          {t('settings.agent.test')}
        </Button>
        {provider.hasApiKey && (
          <Button variant="ghost" disabled={busy !== null} onClick={() => void removeKey()}>
            {t('settings.agent.removeKey')}
          </Button>
        )}
        <Button variant="ghost" isLoading={busy === 'key'} disabled={busy !== null || apiKey.trim() === ''} onClick={() => void storeKey()}>
          {t('settings.agent.saveKey')}
        </Button>
        <Button isLoading={busy === 'save'} disabled={busy !== null || !dirty} onClick={() => void saveFields()}>
          {t('settings.agent.save')}
        </Button>
      </div>
      {feedback &&
        (feedback.kind === 'error' ? (
          <InlineAlert>{feedback.message}</InlineAlert>
        ) : (
          <p className="settings-agent-feedback" role="status">
            {feedback.message}
          </p>
        ))}
    </section>
  )
}
