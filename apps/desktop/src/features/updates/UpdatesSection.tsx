import { useState, type ReactNode } from 'react'
import { openExternalUrl } from '../../bindings/open-external-url'
import type { ReleaseDto, UpdateCommandError, UpdateSourceDto } from '../../bindings/update-types'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Checkbox } from '../../shared/ui/Checkbox'
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { AlertIcon, CheckIcon, DownloadIcon, RefreshIcon, Spinner } from '../../shared/ui/icons'
import { useToast } from '../../shared/ui/use-toast'
import type { SettingsResult, UpdatePhase } from './update-context'
import { needsGitlabAccount, updateErrorMessage } from './update-error-message'
import { isSourceReady } from './update-source'
import { downloadPercent, formatCheckTime, formatMegabytes, formatReleaseDate } from './update-format'
import { useUpdates } from './use-updates'
import './updates.css'

interface UpdatesSectionProps {
  /** Leva o usuário à aba GitLab para conectar (ou reconectar) uma conta. */
  onOpenGitlab: () => void
}

/** "Updates" tab: installed version status, release source, automatic check and preview versions. */
export function UpdatesSection({ onOpenGitlab }: UpdatesSectionProps) {
  return (
    <div className="updates" data-testid="update-settings">
      <UpdateStatusCard onOpenGitlab={onOpenGitlab} />
      <UpdateSourceInfo onOpenGitlab={onOpenGitlab} />
      <StartupCheckSection />
      <PreviewVersionsSection />
    </div>
  )
}

type Tone = 'neutral' | 'success' | 'accent' | 'error'

function UpdateStatusCard({ onOpenGitlab }: UpdatesSectionProps) {
  const { language, t } = useLanguage()
  const { settings, phase, error, checkedAt, check, download, cancel, restart } = useUpdates()
  const [confirmingRestart, setConfirmingRestart] = useState(false)
  const currentVersion = settings?.currentVersion ?? ''
  const source = settings?.source ?? null
  const configured = isSourceReady(source)
  const release = 'release' in phase ? phase.release : null

  const status = describeStatus(phase, { source, loaded: settings !== null, currentVersion, checkedAt, language, t })
  const icon =
    phase.kind === 'checking' || phase.kind === 'installing' ? <Spinner size={16} />
    : status.tone === 'success' ? <CheckIcon size={16} />
    : status.tone === 'accent' ? <DownloadIcon size={16} />
    : error ? <AlertIcon size={16} />
    : <RefreshIcon size={16} />

  let actions: ReactNode
  switch (phase.kind) {
    case 'idle':
    case 'checking':
    case 'upToDate':
      actions = (
        <Button
          variant={phase.kind === 'upToDate' ? 'ghost' : 'primary'}
          disabled={!configured || phase.kind === 'checking'}
          isLoading={phase.kind === 'checking'}
          onClick={() => void check()}
        >
          {phase.kind === 'upToDate' ? t('updates.checkAgain') : t('updates.check')}
        </Button>
      )
      break
    case 'available':
      actions = phase.release.installable ? (
        <Button onClick={() => void download()}>{t('updates.download')}</Button>
      ) : (
        <ReleaseLinkButton release={phase.release} variant="primary" />
      )
      break
    case 'downloading':
      actions = <Button variant="ghost" onClick={cancel}>{t('updates.cancel')}</Button>
      break
    case 'ready':
    case 'installing':
      actions = (
        <Button disabled={phase.kind === 'installing'} isLoading={phase.kind === 'installing'} onClick={() => setConfirmingRestart(true)}>
          {t('updates.restart')}
        </Button>
      )
      break
  }

  return (
    <section className="updates-status" aria-labelledby="updates-status-title">
      <div className="updates-status-main">
        <span className="updates-status-icon" data-tone={error ? 'error' : status.tone} aria-hidden="true">
          {icon}
        </span>
        <div className="updates-status-text" role="status">
          <p id="updates-status-title" className="updates-status-title">{status.title}</p>
          <p className="updates-status-detail">{status.detail}</p>
        </div>
        <div className="updates-status-actions">{actions}</div>
      </div>

      {phase.kind === 'downloading' && <DownloadProgress downloaded={phase.downloaded} total={phase.total} />}

      {error && error.kind !== 'cancelled' && <UpdateErrorAlert error={error} onOpenGitlab={onOpenGitlab} />}

      {release && <ReleaseDetails release={release} />}

      {confirmingRestart && release && (
        <ConfirmDialog
          tone="primary"
          title={t('updates.restartConfirm.title', { version: release.version })}
          description={t('updates.restartConfirm.description')}
          confirmLabel={t('updates.restartConfirm.confirm')}
          cancelLabel={t('updates.restartConfirm.cancel')}
          closeAriaLabel={t('settings.close')}
          onCancel={() => setConfirmingRestart(false)}
          onConfirm={() => {
            setConfirmingRestart(false)
            void restart()
          }}
        />
      )}
    </section>
  )
}

interface StatusContext {
  source: UpdateSourceDto | null
  loaded: boolean
  currentVersion: string
  checkedAt: number | null
  language: ReturnType<typeof useLanguage>['language']
  t: ReturnType<typeof useLanguage>['t']
}

function describeStatus(phase: UpdatePhase, context: StatusContext): { title: string; detail: string; tone: Tone } {
  const { source, loaded, currentVersion, checkedAt, language, t } = context
  const installed = t('updates.installed', { version: currentVersion })

  switch (phase.kind) {
    case 'idle':
      if (!loaded) return { title: t('updates.appName'), detail: t('updates.loading'), tone: 'neutral' }
      return {
        title: installed,
        detail: !source
          ? t('updates.notConfigured')
          : isSourceReady(source) ? t('updates.idle') : t('updates.needsAccount', { host: source.host }),
        tone: 'neutral',
      }
    case 'checking':
      return { title: installed, detail: t('updates.checking'), tone: 'neutral' }
    case 'upToDate':
      return {
        title: installed,
        detail: checkedAt
          ? t('updates.upToDateAt', { time: formatCheckTime(checkedAt, language) })
          : t('updates.upToDate'),
        tone: 'success',
      }
    case 'available':
      return {
        title: t('updates.available', { version: phase.release.version }),
        detail: phase.release.installable
          ? t('updates.availableDetail', { version: currentVersion })
          : t('updates.notInstallable'),
        tone: 'accent',
      }
    case 'downloading':
      return {
        title: t('updates.downloading', { version: phase.release.version }),
        detail: t('updates.downloadingDetail'),
        tone: 'accent',
      }
    case 'ready':
      return {
        title: t('updates.ready', { version: phase.release.version }),
        detail: t('updates.readyDetail'),
        tone: 'success',
      }
    case 'installing':
      return {
        title: t('updates.installing', { version: phase.release.version }),
        detail: t('updates.installingDetail'),
        tone: 'success',
      }
  }
}

function DownloadProgress({ downloaded, total }: { downloaded: number; total: number | null }) {
  const { language, t } = useLanguage()
  const percent = downloadPercent(downloaded, total)
  const label =
    total !== null
      ? t('updates.progress', { downloaded: formatMegabytes(downloaded, language), total: formatMegabytes(total, language) })
      : t('updates.progressUnknown', { downloaded: formatMegabytes(downloaded, language) })

  return (
    <div className="updates-progress">
      <div
        className="updates-progress-track"
        role="progressbar"
        aria-label={t('updates.progressAria')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={label}
        data-indeterminate={percent === null}
      >
        <span className="updates-progress-fill" style={percent !== null ? { width: `${percent}%` } : undefined} />
      </div>
      <span className="updates-progress-label">
        <span>{label}</span>
        {percent !== null && <span>{percent}%</span>}
      </span>
    </div>
  )
}

function UpdateErrorAlert({ error, onOpenGitlab }: { error: UpdateCommandError; onOpenGitlab: () => void }) {
  const { t } = useLanguage()
  return (
    <div className="updates-alert">
      <InlineAlert>{updateErrorMessage(error, t)}</InlineAlert>
      {needsGitlabAccount(error) && (
        <Button variant="ghost" onClick={onOpenGitlab}>{t('updates.openGitlab')}</Button>
      )}
    </div>
  )
}

function ReleaseDetails({ release }: { release: ReleaseDto }) {
  const { language, t } = useLanguage()
  const date = formatReleaseDate(release.publishedAt, language)

  return (
    <div className="updates-release">
      <div className="updates-release-header">
        <div className="updates-release-heading">
          <p className="updates-release-title">{release.name ?? t('updates.releaseTitle', { version: release.version })}</p>
          {date && <p className="updates-release-date">{t('updates.releaseDate', { date })}</p>}
        </div>
        {release.installable && <ReleaseLinkButton release={release} variant="ghost" />}
      </div>
      {release.notes ? (
        <pre className="updates-release-notes" tabIndex={0} aria-label={t('updates.releaseNotes')}>{release.notes}</pre>
      ) : (
        <p className="updates-release-empty">{t('updates.releaseNoNotes')}</p>
      )}
    </div>
  )
}

function ReleaseLinkButton({ release, variant }: { release: ReleaseDto; variant: 'primary' | 'ghost' }) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const webUrl = release.webUrl
  if (!webUrl) return null

  return (
    <Button
      variant={variant}
      onClick={() => {
        void openExternalUrl(webUrl).then((result) => {
          if (!result.ok) showToast(t('updates.linkError'), 'error')
        })
      }}
    >
      {t('updates.openRelease')}
    </Button>
  )
}

/** Origem das releases: fixa no build, só informativa aqui. */
function UpdateSourceInfo({ onOpenGitlab }: UpdatesSectionProps) {
  const { t } = useLanguage()
  const { settings } = useUpdates()
  if (!settings) return null
  const source = settings.source

  return (
    <section className="settings-section settings-preference">
      <div>
        <p className="settings-section-label">{t('updates.sourceLabel')}</p>
      </div>
      <div className="updates-source">
        {source ? (
          <>
            <p className="updates-source-provider">{t(`updates.provider.${source.provider}`)}</p>
            <p className="updates-source-url">{source.location}</p>
            {source.requiresAccount &&
              (source.accountId ? (
                <p className="updates-source-meta">{t('updates.sourceAccount', { account: source.accountId })}</p>
              ) : (
                <div className="updates-alert">
                  <InlineAlert>{t('updates.error.noAccount', { host: source.host })}</InlineAlert>
                  <Button variant="ghost" onClick={onOpenGitlab}>{t('updates.openGitlab')}</Button>
                </div>
              ))}
          </>
        ) : (
          <p className="updates-source-meta">{t('updates.sourceMissing')}</p>
        )}
      </div>
    </section>
  )
}

function StartupCheckSection() {
  const { t } = useLanguage()
  const { settings, setCheckOnStartup } = useUpdates()

  return (
    <PreferenceSection
      label={t('updates.startupLabel')}
      text={t('updates.startupCheck')}
      checked={settings?.checkOnStartup ?? true}
      disabled={settings === null}
      onSave={setCheckOnStartup}
    />
  )
}

function PreviewVersionsSection() {
  const { t } = useLanguage()
  const { settings, setIncludePrereleases } = useUpdates()
  // A direct manifest is a single version: there is no preview to choose.
  const singleVersionSource = settings?.source?.provider === 'manifest'

  return (
    <PreferenceSection
      label={t('updates.previewLabel')}
      text={t('updates.previewInstall')}
      hint={t(singleVersionSource ? 'updates.previewUnsupported' : 'updates.previewHint')}
      checked={settings?.includePrereleases ?? false}
      disabled={settings === null || singleVersionSource}
      onSave={setIncludePrereleases}
    />
  )
}

interface PreferenceSectionProps {
  label: string
  text: string
  hint?: string
  checked: boolean
  disabled: boolean
  onSave: (enabled: boolean) => Promise<SettingsResult>
}

/** A saved on/off update preference, with the error of the last save. */
function PreferenceSection({ label, text, hint, checked, disabled, onSave }: PreferenceSectionProps) {
  const { t } = useLanguage()
  const [error, setError] = useState<UpdateCommandError | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <section className="settings-section settings-preference">
      <div>
        <p className="settings-section-label">{label}</p>
      </div>
      <div className="updates-startup">
        <label className="updates-checkbox">
          <Checkbox
            checked={checked}
            disabled={disabled || busy}
            onChange={(event) => {
              const enabled = event.target.checked
              setBusy(true)
              setError(null)
              void onSave(enabled).then((result) => {
                setBusy(false)
                if (!result.ok) setError(result.error)
              })
            }}
          />
          <span>{text}</span>
        </label>
        {hint && <p className="updates-source-meta">{hint}</p>}
        {error && <InlineAlert>{updateErrorMessage(error, t)}</InlineAlert>}
      </div>
    </section>
  )
}
