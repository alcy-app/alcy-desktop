import { useCallback, useEffect, useRef, useState } from 'react'
import { listValueMonitors } from '../../bindings/list-value-monitors'
import type { ValueMonitorDto, ValueMonitorsError, ValueRuleKind } from '../../bindings/list-value-monitors'
import { saveValueMonitors } from '../../bindings/save-value-monitors'
import { useCommittedState } from '../../shared/use-committed-state'
import { useLanguage } from '../../shared/i18n/use-language'
import { defaultRule, type RuleKindName } from './rule-catalog'

const SAVE_DEBOUNCE_MS = 500

/**
 * Workspace value monitors load on mount and save after an edit debounce.
 * Validation errors identify the monitor and, when applicable, the invalid rule.
 * A disabled feature neither reads nor writes workspace data.
 */
export function useValueMonitorsState(workspaceRootPath: string, onSaved?: () => void, enabled = true) {
  const { t } = useLanguage()
  const [monitors, setMonitors] = useState<ValueMonitorDto[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<ValueMonitorsError | null>(null)
  // An unreadable or newer file must never be overwritten with the empty state shown in the UI.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const saveTimeoutRef = useRef<number | null>(null)
  // Loading changes monitors and loaded together; skip persistence until an actual edit occurs.
  const skipNextSaveRef = useRef(false)

  /** An edit still waiting for its autosave; reloading now would discard it. */
  const hasPendingSave = useCallback(() => saveTimeoutRef.current !== null, [])

  /** Reload from disk and discard pending saves that could overwrite external changes. */
  const reload = useCallback(() => {
    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    setReloadToken((token) => token + 1)
  }, [])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    skipNextSaveRef.current = true
    void listValueMonitors(workspaceRootPath).then((result) => {
      if (cancelled) return
      if (result.ok) setMonitors(result.value)
      setError(result.ok ? null : result.error)
      setLoadError(result.ok ? null : result.error.message)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [workspaceRootPath, reloadToken, enabled])

  useEffect(() => {
    if (!loaded || loadError !== null) return
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false
      return
    }
    if (saveTimeoutRef.current !== null) window.clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = window.setTimeout(() => {
      void saveValueMonitors(workspaceRootPath, monitors).then((result) => {
        setError(result.ok ? null : result.error)
        if (result.ok) onSaved?.()
      })
    }, SAVE_DEBOUNCE_MS)
    return () => {
      if (saveTimeoutRef.current !== null) window.clearTimeout(saveTimeoutRef.current)
    }
  }, [monitors, loaded, loadError, workspaceRootPath, onSaved])

  const commitMonitors = useCommittedState({
    scope: workspaceRootPath,
    value: monitors, ready: loaded && enabled, error: loadError,
    cancelPending: () => { if (saveTimeoutRef.current !== null) window.clearTimeout(saveTimeoutRef.current); saveTimeoutRef.current = null },
    persist: async (next) => {
      const result = await saveValueMonitors(workspaceRootPath, next)
      if (!result.ok) { setError(result.error); throw new Error(result.error.message) }
      onSaved?.()
    },
    apply: (next) => { skipNextSaveRef.current = true; setMonitors([...next]); setError(null) },
    restorePending: () => setMonitors((current) => [...current]),
  })

  const updateMonitor = useCallback((id: string, update: (monitor: ValueMonitorDto) => ValueMonitorDto) => {
    setMonitors((current) => current.map((monitor) => (monitor.id === id ? update(monitor) : monitor)))
  }, [])

  const addMonitor = useCallback((): string => {
    const monitor: ValueMonitorDto = {
      id: crypto.randomUUID(),
      name: t('monitors.newMonitorName'),
      enabled: true,
      fields: [],
      rules: [],
    }
    setMonitors((current) => [...current, monitor])
    return monitor.id
  }, [t])

  const removeMonitor = useCallback((id: string) => {
    setMonitors((current) => current.filter((monitor) => monitor.id !== id))
  }, [])

  const renameMonitor = useCallback(
    (id: string, name: string) => updateMonitor(id, (monitor) => ({ ...monitor, name })),
    [updateMonitor],
  )

  const setMonitorEnabled = useCallback(
    (id: string, enabled: boolean) => updateMonitor(id, (monitor) => ({ ...monitor, enabled })),
    [updateMonitor],
  )

  /** Add a trimmed field, ignoring empty or duplicate values. */
  const addField = useCallback(
    (id: string, field: string) => {
      const trimmed = field.trim()
      if (trimmed === '') return
      updateMonitor(id, (monitor) =>
        monitor.fields.includes(trimmed) ? monitor : { ...monitor, fields: [...monitor.fields, trimmed] },
      )
    },
    [updateMonitor],
  )

  const removeField = useCallback(
    (id: string, field: string) =>
      updateMonitor(id, (monitor) => ({ ...monitor, fields: monitor.fields.filter((current) => current !== field) })),
    [updateMonitor],
  )

  /** Add a rule with default parameters and return its id. */
  const addRule = useCallback(
    (id: string, kind: RuleKindName): string => {
      const ruleId = crypto.randomUUID()
      updateMonitor(id, (monitor) => ({ ...monitor, rules: [...monitor.rules, { id: ruleId, ...defaultRule(kind) }] }))
      return ruleId
    },
    [updateMonitor],
  )

  const updateRule = useCallback(
    (id: string, ruleId: string, rule: ValueRuleKind) =>
      updateMonitor(id, (monitor) => ({
        ...monitor,
        rules: monitor.rules.map((current) => (current.id === ruleId ? { id: ruleId, ...rule } : current)),
      })),
    [updateMonitor],
  )

  const removeRule = useCallback(
    (id: string, ruleId: string) =>
      updateMonitor(id, (monitor) => ({ ...monitor, rules: monitor.rules.filter((rule) => rule.id !== ruleId) })),
    [updateMonitor],
  )

  return {
    commitMonitors,
    monitors,
    loaded,
    loadError,
    error,
    reload,
    hasPendingSave,
    addMonitor,
    removeMonitor,
    renameMonitor,
    setMonitorEnabled,
    addField,
    removeField,
    addRule,
    updateRule,
    removeRule,
  }
}

export type ValueMonitorsState = ReturnType<typeof useValueMonitorsState>
