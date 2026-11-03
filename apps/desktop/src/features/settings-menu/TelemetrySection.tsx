import { useCallback, useEffect, useState } from 'react'
import {
  getUsageEventsStatus,
  listRecentUsageEvents,
  setUsageEventsEnabled,
  type RecordedUsageEvent,
  type UsageEventsStatus,
} from '../../bindings/usage-events'
import { useLanguage } from '../../shared/i18n/use-language'
import { applyUsageEventsStatus } from '../../shared/usage-events/track-usage'
import { Button } from '../../shared/ui/Button'
import { Checkbox } from '../../shared/ui/Checkbox'
import { InlineAlert } from '../../shared/ui/InlineAlert'

/** What each usage event group records (spec 0142), in catalogue order. */
const COLLECTED = [
  'settings.telemetryCollectedApp',
  'settings.telemetryCollectedRequests',
  'settings.telemetryCollectedRuns',
  'settings.telemetryCollectedMocks',
  'settings.telemetryCollectedMonitors',
  'settings.telemetryCollectedImports',
  'settings.telemetryCollectedInterface',
  'settings.telemetryCollectedOther',
  'settings.telemetryCollectedEnvelope',
] as const

/**
 * Settings > Telemetry: what the app records about usage, the person's
 * choice to send it (on by default) and the events recorded in this run,
 * exactly as handed over.
 */
export function TelemetrySection() {
  const { t } = useLanguage()
  const [status, setStatus] = useState<UsageEventsStatus | null>(null)
  const [events, setEvents] = useState<RecordedUsageEvent[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)

  const refreshEvents = useCallback(() => {
    void listRecentUsageEvents().then(setEvents)
  }, [])

  useEffect(() => {
    let current = true
    void getUsageEventsStatus().then((value) => {
      if (current) setStatus(value)
    })
    void listRecentUsageEvents().then((value) => {
      if (current) setEvents(value)
    })
    return () => {
      current = false
    }
  }, [])

  async function toggle(enabled: boolean) {
    setSaving(true)
    setError(false)
    const result = await setUsageEventsEnabled(enabled)
    setSaving(false)
    if (!result.ok) {
      setError(true)
      return
    }
    setStatus(result.value)
    applyUsageEventsStatus(result.value)
    refreshEvents()
  }

  if (!status) return null

  if (!status.available) {
    return (
      <section className="settings-section settings-preference">
        <div>
          <p className="settings-section-label">{t('settings.telemetryLabel')}</p>
        </div>
        <p className="settings-proxy-hint">{t('settings.telemetryUnavailable')}</p>
      </section>
    )
  }

  return (
    <>
      <section className="settings-section settings-preference">
        <div>
          <p className="settings-section-label">{t('settings.telemetryLabel')}</p>
        </div>
        <div className="settings-security">
          <label className="settings-checkbox">
            <Checkbox checked={status.enabled} disabled={saving} onChange={(event) => void toggle(event.target.checked)} />
            <span>{t('settings.telemetryEnable')}</span>
          </label>
          <p className="settings-proxy-hint">{t('settings.telemetryEnableHint')}</p>
          {error && <InlineAlert>{t('settings.telemetrySaveError')}</InlineAlert>}
        </div>
      </section>
      <section className="settings-section settings-telemetry">
        <p className="settings-section-label">{t('settings.telemetryCollectedTitle')}</p>
        <ul className="settings-telemetry-list">
          {COLLECTED.map((key) => <li key={key}>{t(key)}</li>)}
        </ul>
        <p className="settings-section-label">{t('settings.telemetryNeverTitle')}</p>
        <p className="settings-proxy-hint">{t('settings.telemetryNever')}</p>
      </section>
      <section className="settings-section settings-telemetry">
        <div className="settings-telemetry-header">
          <p className="settings-section-label">{t('settings.telemetryRecentTitle')}</p>
          <Button variant="ghost" onClick={refreshEvents}>{t('settings.telemetryRefresh')}</Button>
        </div>
        <p className="settings-proxy-hint">{t('settings.telemetryRecentHint')}</p>
        {!status.enabled ? (
          <p className="settings-proxy-hint">{t('settings.telemetryOff')}</p>
        ) : events.length === 0 ? (
          <p className="settings-proxy-hint">{t('settings.telemetryRecentEmpty')}</p>
        ) : (
          <ol className="settings-telemetry-events" aria-label={t('settings.telemetryRecentTitle')}>
            {[...events].reverse().map((event) => (
              <li key={event.eventId}>
                <span className="settings-telemetry-event-name">{event.name}</span>
                <code>{JSON.stringify({ occurredOn: event.occurredOn, appVersion: event.appVersion, platform: event.platform, ...event.props })}</code>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  )
}
