import { useId, useRef, useState, type ReactNode } from 'react'
import type { ProxyMode } from '../../bindings/get-proxy-settings'
import { useProxy } from '../../shared/proxy/use-proxy'
import { useSecurityPreferences } from '../../shared/security/use-security-preferences'
import { DEFAULT_THEME_PREFERENCE, THEME_PREFERENCES, THEME_PREVIEW, type ThemePreference } from '../../shared/appearance/theme'
import { FEATURE_FLAGS } from '../../shared/feature-flags'
import { isVersionControlEnabled } from '../../shared/version-control-enabled'
import { useTheme } from '../../shared/appearance/use-theme'
import { useUiScale } from '../../shared/appearance/use-ui-scale'
import { DEFAULT_UI_SCALE, MAX_UI_SCALE, MIN_UI_SCALE, UI_SCALE_STEP } from '../../shared/appearance/ui-scale'
import { useLanguage } from '../../shared/i18n/use-language'
import { DEFAULT_LANGUAGE, LANGUAGE_NAMES, type Language } from '../../shared/i18n/translations'
import { Button } from '../../shared/ui/Button'
import { Checkbox } from '../../shared/ui/Checkbox'
import { Field } from '../../shared/ui/Field'
import { IconButton } from '../../shared/ui/IconButton'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { Input } from '../../shared/ui/Input'
import { Modal } from '../../shared/ui/Modal'
import { RangeSlider } from '../../shared/ui/RangeSlider'
import { SegmentedControl } from '../../shared/ui/SegmentedControl'
import { Tooltip } from '../../shared/ui/Tooltip'
import { AlertIcon, CheckIcon, GearIcon } from '../../shared/ui/icons'
import { UpdatesSection } from '../updates/UpdatesSection'
import { AgentSection } from './AgentSection'
import { RequestSettings, HistorySettings, ReleaseNotesSetting } from './GeneralSection'
import { useGeneralSettings } from './use-general-settings'
import { SettingsNavigation } from './SettingsNavigation'
import { settingsDestination, type SettingsCategory, type SettingsPage } from './settings-navigation'
import { APP_VERSION } from '../../shared/app-version'
import alcyIcon from '../../assets/alcy-app-icon.svg'
export type { SettingsCategory } from './settings-navigation'
import { CustomCaCertificatesSection } from './CustomCaCertificatesSection'
import { BodyFilesSection } from './BodyFilesSection'
import { SensitiveSyncSection } from './SensitiveSyncSection'
import { GitIdentitySection } from './GitIdentitySection'
import { TlsVerificationSection } from './TlsVerificationSection'
import { ShortcutsSection } from './ShortcutsSection'
import { TelemetrySection } from './TelemetrySection'
import { SettingsPage as SettingsPagePanel } from './SettingsPage'
import { useSettingDraft, useSettingsAction } from './settings-actions'
import { trackUsage } from '../../shared/usage-events/track-usage'
import './settings-menu.css'

const LANGUAGES: Language[] = ['pt-BR', 'en']
const PROXY_MODES: ProxyMode[] = ['disabled', 'system', 'pac']

interface SettingsMenuProps {
  open: boolean
  initialCategory?: SettingsCategory
  onOpenChange: (open: boolean) => void
  /** Opens the release notes tab; without it, the button in About is disabled. */
  onOpenReleaseNotes?: () => void
  /** Reloads history after a new retention setting is applied. */
  onHistoryRetentionChange?: () => void
  /** Open workspace, for settings that apply to it (picked body files). */
  workspaceRootPath?: string
}

export function SettingsMenu({
  open,
  onOpenChange,
  initialCategory = 'interface',
  onOpenReleaseNotes,
  onHistoryRetentionChange,
  workspaceRootPath,
}: SettingsMenuProps) {
  const { t } = useLanguage()
  const triggerRef = useRef<HTMLButtonElement>(null)

  const close = () => {
    onOpenChange(false)
    triggerRef.current?.focus()
  }

  return (
    <>
      {/* Keep the modal outside the host: React mouse events cross the portal,
          so hovering the modal inside the host would open this tooltip. */}
      <Tooltip label={t('settings.triggerAria')} side="right" className="settings-menu-tooltip" hoverOnly>
        <IconButton
          ref={triggerRef}
          size="md"
          className="settings-menu-button"
          icon={<GearIcon size={15} />}
          label={t('settings.triggerAria')}
          tooltip={false}
          onClick={() => onOpenChange(true)}
        />
      </Tooltip>
      {open && (
        <SettingsModal
          onClose={close}
          initialCategory={initialCategory}
          onHistoryRetentionChange={onHistoryRetentionChange}
          workspaceRootPath={workspaceRootPath}
          onOpenReleaseNotes={
            onOpenReleaseNotes &&
            (() => {
              // The opened tab receives focus in the main area instead of the trigger.
              onOpenChange(false)
              onOpenReleaseNotes()
            })
          }
        />
      )}
    </>
  )
}

interface SettingsModalProps {
  initialCategory: SettingsCategory
  onClose: () => void
  onOpenReleaseNotes?: () => void
  onHistoryRetentionChange?: () => void
  workspaceRootPath?: string
}

function SettingsModal({ onClose, initialCategory, onOpenReleaseNotes, onHistoryRetentionChange, workspaceRootPath }: SettingsModalProps) {
  const { t } = useLanguage()
  const [destination, setDestination] = useState(() => settingsDestination(initialCategory))
  const category = destination.page
  const general = useGeneralSettings()
  const id = useId()
  const navigate = (page: SettingsPage, target?: string) => setDestination({ page, target })
  const panel = (page: SettingsPage, children: ReactNode) => (
    <SettingsPagePanel key={page} page={page} id={`${id}-${page}`} active={category === page} destination={destination}>{children}</SettingsPagePanel>
  )
  const group = (title: string, children: ReactNode) => (
    <section className="settings-group"><h4 className="settings-group-title">{title}</h4>{children}</section>
  )
  const anchor = (target: string, children: ReactNode) => (
    <div data-setting={target} tabIndex={-1} className="settings-anchor">{children}</div>
  )

  return (
    <Modal title={t('settings.modalTitle')} closeAriaLabel={t('settings.close')} onClose={onClose} className="settings-modal">
      <div className="settings-layout">
        <SettingsNavigation page={category} panelId={id} onNavigate={navigate} />
        <div className="settings-main">
          {panel('interface', <InterfaceSettings />)}
          {panel('shortcuts', anchor('shortcuts', <ShortcutsSection />))}
          {panel('requests', group(t('settings.section.execution'), <RequestSettings {...general} />))}
          {panel('network', <>
            {group(t('settings.section.connection'), anchor('proxy', <ProxySection />))}
            {group(t('settings.section.certificates'), <>{anchor('tls', <TlsVerificationSection />)}{anchor('certificates', <CustomCaCertificatesSection />)}</>)}
          </>)}
          {panel('privacy', <>
            {group(t('settings.section.history'), <HistorySettings {...general} onHistoryRetentionChange={onHistoryRetentionChange} />)}
            {group(t('settings.section.protection'), <SecuritySection workspaceRootPath={workspaceRootPath} />)}
            {FEATURE_FLAGS.usageEvents && group(t('settings.category.telemetry'), anchor('telemetry', <TelemetrySection />))}
          </>)}
          {FEATURE_FLAGS.agent && panel('agent', <AgentSection />)}
          {FEATURE_FLAGS.localGit && panel('git', anchor('git', <GitIdentitySection />))}
          {panel('about', <>
            <div className="settings-about-brand"><img className="settings-about-mark" src={alcyIcon} alt="" /><div><strong>Alcy</strong><p>{t('settings.installedVersion', { version: APP_VERSION })}</p></div></div>
            {group(t('settings.section.release'), anchor('release-notes', <ReleaseNotesSetting onOpen={onOpenReleaseNotes} />))}
            {FEATURE_FLAGS.updates && group(t('settings.category.updates'), anchor('updates', <UpdatesSection />))}
          </>)}
        </div>
      </div>
    </Modal>
  )
}

function InterfaceSettings() {
  const { language: savedLanguage, setLanguage: applyLanguage, t } = useLanguage()
  const { textScale: savedTextScale, setTextScale: applyTextScale, iconScale: savedIconScale, setIconScale: applyIconScale } = useUiScale()
  const { preference, setPreference } = useTheme()
  const [language, setLanguage] = useSettingDraft(savedLanguage, DEFAULT_LANGUAGE, (value) => {
    applyLanguage(value)
    trackUsage({ name: 'settings_changed', category: 'general', key: 'language' })
  })
  const [themePreference, setThemePreference] = useSettingDraft(preference, DEFAULT_THEME_PREFERENCE, (value) => {
    setPreference(value)
    trackUsage({ name: 'settings_changed', category: 'appearance', key: 'theme' })
  })
  const [textScale, setTextScale] = useSettingDraft(savedTextScale, DEFAULT_UI_SCALE, applyTextScale)
  const [iconScale, setIconScale] = useSettingDraft(savedIconScale, DEFAULT_UI_SCALE, applyIconScale)
  const group = (title: string, children: ReactNode) => <section className="settings-group"><h4 className="settings-group-title">{title}</h4>{children}</section>
  const anchor = (target: string, children: ReactNode) => <div data-setting={target} tabIndex={-1} className="settings-anchor">{children}</div>
  return (
    <>
      {group(t('settings.section.language'), anchor('language', <section className="settings-section settings-preference">
        <div><p className="settings-section-label">{t('settings.languageLabel')}</p></div>
        <SegmentedControl<Language> ariaLabel={t('settings.languageLabel')} value={language} onChange={setLanguage}
          options={LANGUAGES.map((option) => ({ value: option, label: LANGUAGE_NAMES[option] }))} />
      </section>))}
      {group(t('settings.section.appearance'), <>
        {anchor('theme', <section className="settings-section settings-theme-section">
          <p className="settings-section-label">{t('settings.themeLabel')}</p>
          <div className="settings-theme-options" role="radiogroup" aria-label={t('settings.themeLabel')}>
            {THEME_PREFERENCES.map((option) => <ThemeOption key={option} theme={option} label={t(`settings.theme.${option}`)} active={option === themePreference} onSelect={setThemePreference} />)}
          </div>
        </section>)}
        {anchor('text-scale', <ScaleSetting label={t('settings.textScaleLabel')} value={textScale} onChange={setTextScale} />)}
        {anchor('icon-scale', <ScaleSetting label={t('settings.iconScaleLabel')} value={iconScale} onChange={setIconScale} />)}
      </>)}
    </>
  )
}

interface ScaleSettingProps {
  label: string
  value: number
  onChange: (scale: number) => void
}

function ScaleSetting({ label, value, onChange }: ScaleSettingProps) {
  return (
    <section className="settings-section settings-preference">
      <div>
        <p className="settings-section-label">{label}</p>
      </div>
      <div>
        <div className="settings-scale-control">
          <RangeSlider
            aria-label={label}
            min={MIN_UI_SCALE}
            max={MAX_UI_SCALE}
            step={UI_SCALE_STEP}
            value={value}
            onChange={(event) => onChange(Number(event.target.value))}
          />
          <span className="settings-scale-value">{Math.round(value * 100)}%</span>
        </div>
      </div>
    </section>
  )
}

function ProxySection() {
  const { t } = useLanguage()
  const { settings, applyError, save, test } = useProxy()
  const [mode, setMode] = useState<ProxyMode>(settings.mode)
  const [pacUrl, setPacUrl] = useState(settings.pacUrl ?? '')
  const [busy, setBusy] = useState<'test' | 'apply' | null>(null)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null)

  // Saved settings may arrive or change after this section mounts.
  // Keep the draft in sync while preserving feedback from the last action.
  const [syncedSettings, setSyncedSettings] = useState(settings)
  if (syncedSettings !== settings) {
    setSyncedSettings(settings)
    setMode(settings.mode)
    setPacUrl(settings.pacUrl ?? '')
  }

  const input = { mode, pacUrl: mode === 'pac' ? pacUrl.trim() : null }
  const dirty = mode !== settings.mode || (mode === 'pac' && pacUrl.trim() !== (settings.pacUrl ?? ''))
  const pacMissing = mode === 'pac' && pacUrl.trim() === ''

  const changeMode = (next: ProxyMode) => {
    setMode(next)
    setFeedback(null)
  }

  const runTest = async () => {
    setBusy('test')
    setFeedback(null)
    const result = await test(input)
    setBusy(null)
    setFeedback(
      result.ok
        ? { kind: 'ok', message: t('settings.proxyTestOk') }
        : { kind: 'error', message: t('settings.proxyError', { message: result.error.message }) },
    )
  }

  const runApply = async () => {
    setBusy('apply')
    setFeedback(null)
    const result = await save(input)
    setBusy(null)
    setFeedback(
      result.ok
        ? { kind: 'ok', message: t('settings.proxyApplied') }
        : { kind: 'error', message: t('settings.proxyError', { message: result.error.message }) },
    )
    return result.ok
  }

  useSettingsAction({
    dirty,
    isDefault: mode === 'disabled',
    blocked: busy !== null,
    invalid: pacMissing,
    apply: runApply,
    restore: () => { setMode('disabled'); setPacUrl(''); setFeedback(null) },
  })

  return (
    <div className="settings-section settings-proxy" data-testid="proxy-settings">
      <p className="settings-section-label">{t('settings.proxyLabel')}</p>
      <div>
        <SegmentedControl<ProxyMode>
          ariaLabel={t('settings.proxyLabel')}
          value={mode}
          onChange={changeMode}
          options={PROXY_MODES.map((option) => ({ value: option, label: t(`settings.proxy.${option}`), disabled: busy !== null }))}
        />
      </div>
      {mode === 'pac' && <p className="settings-proxy-hint">{t('settings.proxyPacHint')}</p>}
      {mode === 'pac' && (
        <Field label={t('settings.proxyPacUrlLabel')} className="settings-proxy-field">
          {(id) => (
            <Input
              id={id}
              disabled={busy !== null}
              mono
              type="url"
              value={pacUrl}
              placeholder={t('settings.proxyPacUrlPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setPacUrl(event.target.value)
                setFeedback(null)
              }}
            />
          )}
        </Field>
      )}
      {applyError && !dirty && !feedback && <InlineAlert>{t('settings.proxyApplyError', { message: applyError })}</InlineAlert>}
      {feedback?.kind === 'error' && <InlineAlert>{feedback.message}</InlineAlert>}
      {feedback?.kind === 'ok' && (
        <p className="settings-proxy-success" role="status">
          {feedback.message}
        </p>
      )}
      <div className="settings-proxy-actions">
        {mode === 'pac' && (
          <Button variant="ghost" disabled={pacMissing || busy !== null} isLoading={busy === 'test'} onClick={() => void runTest()}>
            {t('settings.proxyTest')}
          </Button>
        )}
      </div>
    </div>
  )
}

function SecuritySection({ workspaceRootPath }: { workspaceRootPath?: string }) {
  const { t } = useLanguage()
  const { redactHarSensitiveData: savedRedaction, setRedactHarSensitiveData: applyRedaction } = useSecurityPreferences()
  const [redactHarSensitiveData, setRedactHarSensitiveData] = useSettingDraft(savedRedaction, true, applyRedaction)

  return (
    <>
      <section className="settings-section settings-preference" data-setting="har" tabIndex={-1}>
        <div>
          <p className="settings-section-label">{t('settings.securityHarLabel')}</p>
        </div>
        <div className="settings-security">
          <label className="settings-checkbox">
            <Checkbox
              checked={redactHarSensitiveData}
              onChange={(event) => setRedactHarSensitiveData(event.target.checked)}
            />
            <span>{t('settings.securityHarRedact')}</span>
          </label>
          <p className="settings-proxy-hint">{t('settings.securityHarRedactHint')}</p>
          {!redactHarSensitiveData && (
            <p className="settings-security-warning" role="status">
              <AlertIcon size={13} />
              <span>{t('settings.securityHarRevealWarning')}</span>
            </p>
          )}
        </div>
      </section>
      {isVersionControlEnabled() && <div className="settings-anchor" data-setting="sensitive-sync" tabIndex={-1}><SensitiveSyncSection /></div>}
      <div className="settings-anchor" data-setting="body-files" tabIndex={-1}><BodyFilesSection rootPath={workspaceRootPath} /></div>
    </>
  )
}

interface ThemeOptionProps {
  theme: ThemePreference
  label: string
  active: boolean
  onSelect: (theme: ThemePreference) => void
}

function ThemeOption({ theme, label, active, onSelect }: ThemeOptionProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      tabIndex={active ? 0 : -1}
      className={active ? 'settings-theme-option settings-theme-option--active' : 'settings-theme-option'}
      onClick={() => onSelect(theme)}
      onKeyDown={(event) => {
        const index = THEME_PREFERENCES.indexOf(theme)
        let next: number
        switch (event.key) {
          case 'ArrowRight': case 'ArrowDown': next = (index + 1) % THEME_PREFERENCES.length; break
          case 'ArrowLeft': case 'ArrowUp': next = (index + THEME_PREFERENCES.length - 1) % THEME_PREFERENCES.length; break
          case 'Home': next = 0; break
          case 'End': next = THEME_PREFERENCES.length - 1; break
          default: return
        }
        event.preventDefault()
        onSelect(THEME_PREFERENCES[next])
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
      }}
    >
      <span className="settings-theme-preview" aria-hidden="true" style={{ backgroundColor: THEME_PREVIEW[theme][0], color: THEME_PREVIEW[theme][2] }}>
        <span className="settings-theme-preview-sidebar" style={{ backgroundColor: THEME_PREVIEW[theme][1] }}><i /><i /><i /></span>
        <span className="settings-theme-preview-body"><i style={{ backgroundColor: THEME_PREVIEW[theme][3] }} /><i /><i /></span>
        {theme === 'system' && <span className="settings-theme-preview-dark" style={{ backgroundColor: THEME_PREVIEW.dark[0], color: THEME_PREVIEW.dark[2] }}><i /><i /></span>}
      </span>
      <span className="settings-theme-name">{label}{active && <CheckIcon size={12} />}</span>
    </button>
  )
}
