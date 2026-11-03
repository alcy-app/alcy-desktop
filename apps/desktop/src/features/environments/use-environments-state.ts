import { useCallback, useEffect, useRef, useState } from 'react'
import { listEnvironments } from '../../bindings/list-environments'
import type { EnvironmentDto } from '../../bindings/list-environments'
import type { EnvironmentMergeDto } from '../../bindings/import-collections'
import { saveEnvironments } from '../../bindings/save-environments'
import { useCommittedState } from '../../shared/use-committed-state'
import { useLanguage } from '../../shared/i18n/use-language'
import { matchExistingRows, type BulkRow } from '../../shared/bulk-edit'
import type { SiblingEdge } from '../../shared/use-pointer-drag'
import { trackUsage } from '../../shared/usage-events/track-usage'
import { definedVariables } from './defined-variables'
import type { EnvironmentState, VariableRow } from './environments.types'
import { SENSITIVE_MASK } from './environments.types'
import { moveById } from './reorder'

const SAVE_DEBOUNCE_MS = 500

let variableIdSequence = 0
const nextVariableId = () => `variable-${++variableIdSequence}`

function createEnvironment(name: string): EnvironmentState {
  return { id: crypto.randomUUID(), name, variables: [] }
}

/** Upserts imported variables by name into existing environments (spec 0130), keeping the ids of rows already there. */
export function mergeImportedVariables(environments: EnvironmentState[], merges: EnvironmentMergeDto[]): EnvironmentState[] {
  if (merges.length === 0) return environments
  return environments.map((environment) => {
    const incoming = merges.filter((merge) => merge.environmentId === environment.id).flatMap((merge) => merge.variables)
    if (incoming.length === 0) return environment
    const variables = [...environment.variables]
    for (const variable of incoming) {
      const index = variables.findIndex((row) => row.name === variable.name)
      if (index >= 0) variables[index] = { ...variables[index], value: variable.value, sensitive: variable.sensitive }
      else variables.push({ id: nextVariableId(), ...variable })
    }
    return { ...environment, variables }
  })
}

export function useEnvironmentsState(workspaceRootPath: string, onSaved?: () => void) {
  const { t } = useLanguage()
  const [environments, setEnvironments] = useState<EnvironmentState[]>([])
  const [activeEnvironmentId, setActiveEnvironmentId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  // An unreadable or newer file must never be overwritten with the empty state shown in the UI.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [unreadableSecrets, setUnreadableSecrets] = useState<string[]>([])
  const saveTimeoutRef = useRef<number | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  // Loading changes environments and loaded together; skip persistence until an actual edit occurs.
  const skipNextSaveRef = useRef(false)

  /** Reload from disk and discard pending saves that could overwrite external changes. */
  const reload = useCallback(() => {
    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    setReloadToken((token) => token + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    skipNextSaveRef.current = true

    void listEnvironments(workspaceRootPath).then((result) => {
      if (cancelled) return

      if (result.ok) {
        const loadedEnvironments = result.value.environments.map((environment) => ({
          id: environment.id,
          name: environment.name,
          variables: environment.variables.map((variable) => ({ id: nextVariableId(), ...variable })),
        }))
        setEnvironments(loadedEnvironments)
        setUnreadableSecrets(result.value.unreadableSecrets)

        const requestedActiveId = result.value.activeEnvironmentId
        const activeId = loadedEnvironments.some((environment) => environment.id === requestedActiveId)
          ? requestedActiveId
          : (loadedEnvironments[0]?.id ?? null)
        setActiveEnvironmentId(activeId)
      }

      setLoadError(result.ok ? null : result.error.message)
      setLoaded(true)
    })

    return () => {
      cancelled = true
    }
  }, [workspaceRootPath, reloadToken])

  useEffect(() => {
    if (!loaded || loadError !== null) return
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false
      return
    }

    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current)
    }

    saveTimeoutRef.current = window.setTimeout(() => {
      void saveEnvironments(workspaceRootPath, {
        environments: environments.map((environment) => ({
          id: environment.id,
          name: environment.name,
          // Unnamed rows are drafts; persisting them would reject the entire snapshot.
          variables: definedVariables(environment.variables).map(({ name, value, sensitive }) => ({ name, value, sensitive })),
        })),
        activeEnvironmentId,
      }).then(() => onSaved?.())
    }, SAVE_DEBOUNCE_MS)

    return () => {
      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [environments, activeEnvironmentId, loaded, loadError, workspaceRootPath, onSaved])

  const commitEnvironments = useCommittedState({
    scope: workspaceRootPath,
    value: { environments, activeEnvironmentId }, ready: loaded, error: loadError,
    cancelPending: () => { if (saveTimeoutRef.current !== null) window.clearTimeout(saveTimeoutRef.current); saveTimeoutRef.current = null },
    persist: async (next) => {
      const result = await saveEnvironments(workspaceRootPath, {
        environments: next.environments.map((environment) => ({ ...environment, variables: definedVariables(environment.variables).map(({ name, value, sensitive }) => ({ name, value, sensitive })) })),
        activeEnvironmentId: next.activeEnvironmentId,
      })
      if (!result.ok) throw new Error(result.error.message)
      onSaved?.()
    },
    apply: (next) => { skipNextSaveRef.current = true; setEnvironments([...next.environments]); setActiveEnvironmentId(next.activeEnvironmentId) },
    restorePending: () => setEnvironments((current) => [...current]),
  })

  const activeEnvironment = environments.find((environment) => environment.id === activeEnvironmentId) ?? null

  const addEnvironment = useCallback(() => {
    const environment = createEnvironment(t('environments.newEnvironmentName'))
    setEnvironments((current) => [...current, environment])
    setActiveEnvironmentId(environment.id)
  }, [t])

  const removeEnvironment = useCallback((id: string) => {
    setEnvironments((current) => {
      const remaining = current.filter((environment) => environment.id !== id)
      setActiveEnvironmentId((currentActiveId) => (currentActiveId === id ? (remaining[0]?.id ?? null) : currentActiveId))
      return remaining
    })
  }, [])

  /** Duplicate below the original with new ids and select the copy. Sensitive values stay
   * in the same workspace and are encrypted again on save. */
  const duplicateEnvironment = useCallback(
    (id: string) => {
      const copyId = crypto.randomUUID()
      setEnvironments((current) => {
        const index = current.findIndex((environment) => environment.id === id)
        if (index < 0) return current
        const original = current[index]
        const copy: EnvironmentState = {
          id: copyId,
          name: t('environments.copyName', { name: original.name || t('common.unnamed') }),
          variables: original.variables.map((variable) => ({ ...variable, id: nextVariableId() })),
        }
        setActiveEnvironmentId(copyId)
        return [...current.slice(0, index + 1), copy, ...current.slice(index + 1)]
      })
    },
    [t],
  )

  const renameEnvironment = useCallback((id: string, name: string) => {
    setEnvironments((current) =>
      current.map((environment) => (environment.id === id ? { ...environment, name } : environment)),
    )
  }, [])

  /** Reorder environments by pointer or keyboard; the order is persisted. */
  const moveEnvironment = useCallback((draggedId: string, targetId: string, edge: SiblingEdge) => {
    setEnvironments((current) => moveById(current, draggedId, targetId, edge))
  }, [])

  /** Reorder variables without changing resolution; names are unique within an environment. */
  const moveVariable = useCallback((environmentId: string, draggedId: string, targetId: string, edge: SiblingEdge) => {
    setEnvironments((current) => {
      let changed = false
      const next = current.map((environment) => {
        if (environment.id !== environmentId) return environment
        const variables = moveById(environment.variables, draggedId, targetId, edge)
        if (variables === environment.variables) return environment
        changed = true
        return { ...environment, variables }
      })
      // Preserve the reference when nothing changed to avoid a redundant save.
      return changed ? next : current
    })
  }, [])

  const addVariable = useCallback((environmentId: string) => {
    setEnvironments((current) =>
      current.map((environment) =>
        environment.id === environmentId
          ? {
              ...environment,
              variables: [...environment.variables, { id: nextVariableId(), name: '', value: '', sensitive: false }],
            }
          : environment,
      ),
    )
  }, [])

  const updateVariable = useCallback(
    (environmentId: string, variableId: string, patch: Partial<Omit<VariableRow, 'id'>>) => {
      setEnvironments((current) =>
        current.map((environment) =>
          environment.id === environmentId
            ? {
                ...environment,
                variables: environment.variables.map((variable) =>
                  variable.id === variableId ? { ...variable, ...patch } : variable,
                ),
              }
            : environment,
        ),
      )
    },
    [],
  )

  /** Replace variables from bulk editing, preserving matching row ids and sensitivity.
   * A masked value retains the original sensitive value. */
  const replaceVariables = useCallback((environmentId: string, rows: BulkRow[]) => {
    setEnvironments((current) =>
      current.map((environment) => {
        if (environment.id !== environmentId) return environment
        const matches = matchExistingRows(environment.variables, rows)
        const variables = rows.map((row, index) => {
          const match = matches[index]
          const keepsSecret = match?.sensitive === true && row.value === SENSITIVE_MASK
          return {
            id: match?.id ?? nextVariableId(),
            name: row.name,
            value: keepsSecret ? match.value : row.value,
            sensitive: match?.sensitive ?? false,
          }
        })
        return { ...environment, variables }
      }),
    )
  }, [])

  /** Append imported environments with regenerated environment and variable ids to avoid
   * collisions between successive imports or existing workspace data. */
  const importEnvironments = useCallback((dtos: EnvironmentDto[], merges: EnvironmentMergeDto[] = []) => {
    setEnvironments((current) => [
      ...mergeImportedVariables(current, merges),
      ...dtos.map((dto) => ({
        id: crypto.randomUUID(),
        name: dto.name,
        variables: dto.variables.map((variable) => ({ id: nextVariableId(), ...variable })),
      })),
    ])
  }, [])

  /** Upsert script variable changes into the active environment using the regular save
   * debounce. With no active environment, there is no target for those changes. */
  const applyScriptChanges = useCallback(
    (changes: { name: string; value: string | null }[]) => {
      if (changes.length === 0 || activeEnvironmentId === null) return
      setEnvironments((current) =>
        current.map((environment) => {
          if (environment.id !== activeEnvironmentId) return environment
          const variables = [...environment.variables]
          for (const change of changes) {
            if (change.value === null) {
              const index = variables.findIndex((variable) => variable.name === change.name)
              if (index >= 0) variables.splice(index, 1)
              continue
            }
            const index = variables.findIndex((variable) => variable.name === change.name)
            if (index >= 0) variables[index] = { ...variables[index], value: change.value }
            else variables.push({ id: nextVariableId(), name: change.name, value: change.value, sensitive: false })
          }
          return { ...environment, variables }
        }),
      )
    },
    [activeEnvironmentId],
  )

  /** Creates or updates `name` in an environment; `sensitive` left undefined keeps the current flag. */
  const upsertVariable = useCallback((environmentId: string, name: string, value: string, sensitive?: boolean) => {
    setEnvironments((current) =>
      current.map((environment) => {
        if (environment.id !== environmentId) return environment
        const index = environment.variables.findIndex((variable) => variable.name === name)
        if (index < 0) {
          return { ...environment, variables: [...environment.variables, { id: nextVariableId(), name, value, sensitive: sensitive ?? false }] }
        }
        const variables = [...environment.variables]
        variables[index] = { ...variables[index], value, sensitive: sensitive ?? variables[index].sensitive }
        return { ...environment, variables }
      }),
    )
  }, [])

  const removeVariable = useCallback((environmentId: string, variableId: string) => {
    setEnvironments((current) =>
      current.map((environment) =>
        environment.id === environmentId
          ? { ...environment, variables: environment.variables.filter((variable) => variable.id !== variableId) }
          : environment,
      ),
    )
  }, [])

  // The person picked another environment (never its name: spec 0142).
  const selectActiveEnvironment = useCallback((id: string | null) => {
    if (id !== activeEnvironmentId) trackUsage({ name: 'environment_switched' })
    setActiveEnvironmentId(id)
  }, [activeEnvironmentId])

  return {
    commitEnvironments,
    environments,
    loaded,
    loadError,
    unreadableSecrets,
    reload,
    activeEnvironmentId,
    activeEnvironment,
    setActiveEnvironmentId: selectActiveEnvironment,
    addEnvironment,
    removeEnvironment,
    duplicateEnvironment,
    renameEnvironment,
    moveEnvironment,
    addVariable,
    updateVariable,
    upsertVariable,
    removeVariable,
    moveVariable,
    replaceVariables,
    importEnvironments,
    applyScriptChanges,
  }
}
