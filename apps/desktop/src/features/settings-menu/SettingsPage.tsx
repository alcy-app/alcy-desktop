import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { AlertIcon, CheckIcon } from '../../shared/ui/icons'
import { SettingsActionsContext, type SettingsAction } from './settings-actions'
import type { SettingsPage as Page } from './settings-navigation'

export function SettingsPage({ page, active, id, destination, children }: {
  page: Page
  active: boolean
  id: string
  destination?: { page: Page; target?: string }
  children: ReactNode
}) {
  const { t } = useLanguage()
  const contentRef = useRef<HTMLDivElement>(null)
  const applying = useRef(false)
  const [actions, setActions] = useState<Map<string, SettingsAction>>(() => new Map())
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<'saved' | 'error' | null>(null)
  const register = useCallback((key: string, action: SettingsAction) => {
    setActions((current) => new Map(current).set(key, action))
    return () => setActions((current) => {
      const next = new Map(current)
      next.delete(key)
      return next
    })
  }, [])
  const [context] = useState(() => ({ register }))
  const fields = [...actions.values()]
  const dirty = fields.some((field) => field.dirty)
  const blocked = fields.some((field) => field.blocked)
  const invalid = fields.some((field) => field.invalid)
  const isDefault = fields.every((field) => field.isDefault)

  useEffect(() => {
    if (!active) return
    const content = contentRef.current
    if (!content) return
    const target = destination?.target
    if (!target) { content.scrollTop = 0; return }
    const setting = content.querySelector<HTMLElement>(`[data-setting="${target}"]`)
    setting?.scrollIntoView?.({ block: 'start' })
    setting?.focus({ preventScroll: true })
  }, [active, destination])

  const apply = async () => {
    if (applying.current || blocked || invalid || !dirty) return
    applying.current = true
    setBusy(true)
    setFeedback(null)
    try {
      for (const field of fields.filter((field) => field.dirty)) {
        if (await field.apply() === false) {
          setFeedback('error')
          return
        }
      }
      setFeedback('saved')
    } catch {
      setFeedback('error')
    } finally {
      applying.current = false
      setBusy(false)
    }
  }

  return (
    <SettingsActionsContext.Provider value={context}>
      <form id={id} hidden={!active} className="settings-page" noValidate onSubmit={(event) => { event.preventDefault(); void apply() }}>
        <div ref={contentRef} className="settings-content">
          <header className="settings-page-header">
            <h3>{t(`settings.category.${page}`)}</h3>
            <p>{t(`settings.description.${page}`)}</p>
          </header>
          <fieldset className="settings-page-fields" disabled={busy}>{children}</fieldset>
        </div>
        {fields.length > 0 && <footer className="settings-page-footer" aria-label={t('settings.actions.label', { tab: t(`settings.category.${page}`) })}>
          <p className="settings-page-status" role="status" data-state={feedback === 'error' ? 'error' : dirty ? 'pending' : feedback}>
            {feedback === 'error' ? <><AlertIcon size={14} />{t('settings.actions.error')}</>
              : dirty ? <><span className="settings-pending-dot" />{t('settings.actions.pending')}</>
                : feedback === 'saved' ? <><CheckIcon size={14} />{t('settings.actions.saved')}</> : t('settings.actions.scope')}
          </p>
          <div className="settings-page-buttons">
            <Button variant="ghost" disabled={busy || blocked || isDefault} onClick={() => {
              setFeedback(null)
              fields.forEach((field) => field.restore?.())
            }}>{t('settings.actions.restore')}</Button>
            <Button type="submit" disabled={busy || blocked || invalid || !dirty} isLoading={busy}>{t('settings.actions.apply')}</Button>
          </div>
        </footer>}
      </form>
    </SettingsActionsContext.Provider>
  )
}
