import { useEffect, useId, useRef, useState } from 'react'
import type { ProxyMode } from '../../bindings/get-proxy-settings'
import { useProxy } from '../../shared/proxy/use-proxy'
import { useSecurityPreferences } from '../../shared/security/use-security-preferences'
import { THEME_PREVIEW, THEMES, type Theme } from '../../shared/appearance/theme'
import { FEATURE_FLAGS } from '../../shared/feature-flags'
import { useTheme } from '../../shared/appearance/use-theme'
import { useUiScale } from '../../shared/appearance/use-ui-scale'
import { DEFAULT_UI_SCALE, MAX_UI_SCALE, MIN_UI_SCALE, UI_SCALE_STEP } from '../../shared/appearance/ui-scale'
import { useLanguage } from '../../shared/i18n/use-language'
import { LANGUAGE_NAMES, type Language } from '../../shared/i18n/translations'
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
import { AlertIcon, CheckIcon, ComponentsIcon, FolderIcon, GearIcon, GitIcon, KeyboardIcon, LockIcon, ProxyIcon, RefreshIcon } from '../../shared/ui/icons'
import { UpdatesSection } from '../updates/UpdatesSection'
import { GeneralSection } from './GeneralSection'
import { CustomCaCertificatesSection } from './CustomCaCertificatesSection'
import { GitlabAccountSection } from './GitlabAccountSection'
import { OnedriveAccountSection } from './OnedriveAccountSection'
import { SensitiveSyncSection } from './SensitiveSyncSection'
import { TlsVerificationSection } from './TlsVerificationSection'
import { ShortcutsSection } from './ShortcutsSection'
import './settings-menu.css'

const LANGUAGES: Language[] = ['pt-BR', 'en']
const PROXY_MODES: ProxyMode[] = ['disabled', 'system', 'pac']

interface SettingsMenuProps {
  open: boolean
  initialCategory?: SettingsCategory
  onOpenChange: (open: boolean) => void
  /** Abre a aba "Novidades da versão"; sem ele, o botão em Geral fica desabilitado. */
  onOpenReleaseNotes?: () => void
  /** Recarrega o histórico depois de uma nova retenção ser aplicada. */
  onHistoryRetentionChange?: () => void
}

export function SettingsMenu({
  open,
  onOpenChange,
  initialCategory = 'general',
  onOpenReleaseNotes,
  onHistoryRetentionChange,
}: SettingsMenuProps) {
  const { t } = useLanguage()
  const triggerRef = useRef<HTMLButtonElement>(null)

  const close = () => {
    onOpenChange(false)
    triggerRef.current?.focus()
  }

  return (
    <>
      {/* O modal fica fora do host: eventos de mouse do React atravessam o
          portal e, dentro do host, o hover no modal abriria este tooltip. */}
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
          onOpenReleaseNotes={
            onOpenReleaseNotes &&
            (() => {
              // A aba aberta recebe o foco da área principal; não volta para o botão.
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
}

function SettingsModal({ onClose, initialCategory, onOpenReleaseNotes, onHistoryRetentionChange }: SettingsModalProps) {
  const { language, setLanguage, t } = useLanguage()
  const { textScale, setTextScale, iconScale, setIconScale } = useUiScale()
  const { theme, setTheme } = useTheme()
  const [category, setCategory] = useState<SettingsCategory>(isCategoryDisabled(initialCategory) ? 'general' : initialCategory)
  const navigationRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const id = useId()

  useEffect(() => {
    navigationRef.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus()
  }, [])

  return (
    <Modal title={t('settings.modalTitle')} closeAriaLabel={t('settings.close')} onClose={onClose} className="settings-modal">
      <div className="settings-layout">
        <nav ref={navigationRef} className="settings-navigation" aria-label={t('settings.categories')}>
          {CATEGORIES.filter(({ key }) => !isCategoryHidden(key)).map(({ key, icon: Icon }) => {
            const disabled = isCategoryDisabled(key)
            const item = (
              <button
                key={key}
                type="button"
                disabled={disabled}
                aria-current={category === key ? 'page' : undefined}
                aria-controls={disabled ? undefined : `${id}-${key}`}
                className="settings-navigation-item"
                onClick={() => {
                  setCategory(key)
                  if (contentRef.current) contentRef.current.scrollTop = 0
                }}
              >
                <Icon size={15} />
                <span>{t(`settings.category.${key}`)}</span>
              </button>
            )
            return disabled ? (
              <Tooltip key={key} label={t('settings.featureDisabled')} className="settings-navigation-tooltip">
                {item}
              </Tooltip>
            ) : (
              item
            )
          })}
        </nav>
        <div ref={contentRef} className="settings-content">
          <header className="settings-page-header">
            <h3>{t(`settings.category.${category}`)}</h3>
          </header>
          <div id={`${id}-general`} hidden={category !== 'general'}>
            <section className="settings-section settings-preference">
              <div>
                <p className="settings-section-label">{t('settings.languageLabel')}</p>
              </div>
              <SegmentedControl<Language>
                ariaLabel={t('settings.languageLabel')}
                value={language}
                onChange={setLanguage}
                options={LANGUAGES.map((option) => ({ value: option, label: LANGUAGE_NAMES[option] }))}
              />
            </section>
            <GeneralSection onOpenReleaseNotes={onOpenReleaseNotes} onHistoryRetentionChange={onHistoryRetentionChange} />
          </div>
          <div id={`${id}-appearance`} hidden={category !== 'appearance'}>
            <section className="settings-section settings-preference">
              <div>
                <p className="settings-section-label">{t('settings.themeLabel')}</p>
              </div>
              <div className="settings-theme-options" role="radiogroup" aria-label={t('settings.themeLabel')}>
                {THEMES.map((option) => (
                  <ThemeOption key={option} theme={option} label={t(`settings.theme.${option}`)} active={option === theme} onSelect={setTheme} />
                ))}
              </div>
            </section>
            <ScaleSetting label={t('settings.textScaleLabel')} value={textScale} onChange={setTextScale} />
            <ScaleSetting label={t('settings.iconScaleLabel')} value={iconScale} onChange={setIconScale} />
          </div>
          <div id={`${id}-shortcuts`} hidden={category !== 'shortcuts'}><ShortcutsSection /></div>
          <div id={`${id}-network`} hidden={category !== 'network'}><ProxySection /><TlsVerificationSection /><CustomCaCertificatesSection /></div>
          <div id={`${id}-security`} hidden={category !== 'security'}><SecuritySection /></div>
          {FEATURE_FLAGS.gitlab && <div id={`${id}-gitlab`} hidden={category !== 'gitlab'}><GitlabAccountSection /></div>}
          {FEATURE_FLAGS.onedrive && <div id={`${id}-onedrive`} hidden={category !== 'onedrive'}><OnedriveAccountSection /></div>}
          {FEATURE_FLAGS.updates && (
            <div id={`${id}-updates`} hidden={category !== 'updates'}>
              <UpdatesSection
                onOpenGitlab={() => {
                  setCategory('gitlab')
                  if (contentRef.current) contentRef.current.scrollTop = 0
                }}
              />
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

interface ScaleSettingProps {
  label: string
  value: number
  onChange: (scale: number) => void
}

function ScaleSetting({ label, value, onChange }: ScaleSettingProps) {
  const { t } = useLanguage()
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
        <div className="settings-scale-footer">
          <Button variant="ghost" disabled={value === DEFAULT_UI_SCALE} onClick={() => onChange(DEFAULT_UI_SCALE)}>{t('settings.resetScale')}</Button>
        </div>
      </div>
    </section>
  )
}

const CATEGORIES = [
  { key: 'general', icon: GearIcon },
  { key: 'appearance', icon: ComponentsIcon },
  { key: 'shortcuts', icon: KeyboardIcon },
  { key: 'network', icon: ProxyIcon },
  { key: 'security', icon: LockIcon },
  { key: 'gitlab', icon: GitIcon },
  { key: 'onedrive', icon: FolderIcon },
  { key: 'updates', icon: RefreshIcon },
] as const

export type SettingsCategory = (typeof CATEGORIES)[number]['key']

/** Version control providers whose flag is off are left out of the menu. */
function isCategoryHidden(key: SettingsCategory): boolean {
  if (key === 'gitlab') return !FEATURE_FLAGS.gitlab
  if (key === 'onedrive') return !FEATURE_FLAGS.onedrive
  return false
}

/** Other disabled features stay in the menu, but disabled. */
function isCategoryDisabled(key: SettingsCategory): boolean {
  if (key === 'updates') return !FEATURE_FLAGS.updates
  return isCategoryHidden(key)
}

function ProxySection() {
  const { t } = useLanguage()
  const { settings, applyError, save, test } = useProxy()
  const [mode, setMode] = useState<ProxyMode>(settings.mode)
  const [pacUrl, setPacUrl] = useState(settings.pacUrl ?? '')
  const [busy, setBusy] = useState<'test' | 'apply' | null>(null)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null)

  // A configuração salva pode chegar (ou mudar) depois de a seção montar: o
  // rascunho acompanha, mantendo o feedback da última ação.
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
  }

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
        <Button disabled={!dirty || pacMissing || busy !== null} isLoading={busy === 'apply'} onClick={() => void runApply()}>
          {t('settings.proxyApply')}
        </Button>
      </div>
    </div>
  )
}

function SecuritySection() {
  const { t } = useLanguage()
  const { redactHarSensitiveData, setRedactHarSensitiveData } = useSecurityPreferences()

  return (
    <>
      <section className="settings-section settings-preference">
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
      {(FEATURE_FLAGS.gitlab || FEATURE_FLAGS.onedrive) && <SensitiveSyncSection />}
    </>
  )
}

interface ThemeOptionProps {
  theme: Theme
  label: string
  active: boolean
  onSelect: (theme: Theme) => void
}

function ThemeOption({ theme, label, active, onSelect }: ThemeOptionProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      className={active ? 'settings-theme-option settings-theme-option--active' : 'settings-theme-option'}
      onClick={() => onSelect(theme)}
    >
      <span className="settings-theme-swatches" aria-hidden="true">
        {THEME_PREVIEW[theme].map((color) => (
          <span key={color} className="settings-theme-swatch" style={{ backgroundColor: color }} />
        ))}
      </span>
      <span className="settings-theme-name">{label}{active && <CheckIcon size={12} />}</span>
    </button>
  )
}
