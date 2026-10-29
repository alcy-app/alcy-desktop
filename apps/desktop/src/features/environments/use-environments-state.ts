import { useCallback, useEffect, useRef, useState } from 'react'
import { listEnvironments } from '../../bindings/list-environments'
import type { EnvironmentDto } from '../../bindings/list-environments'
import type { EnvironmentMergeDto } from '../../bindings/import-collections'
import { saveEnvironments } from '../../bindings/save-environments'
import { useLanguage } from '../../shared/i18n/use-language'
import { matchExistingRows, type BulkRow } from '../../shared/bulk-edit'
import type { SiblingEdge } from '../../shared/use-pointer-drag'
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
  // Arquivo que não foi lido (ex.: gravado por uma versão mais nova do app): enquanto houver erro,
  // nada é salvo, para não trocar o conteúdo do disco pelo estado vazio mostrado na tela.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [unreadableSecrets, setUnreadableSecrets] = useState<string[]>([])
  const saveTimeoutRef = useRef<number | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  // O efeito de salvar reage a `environments`/`loaded` juntos — sem isso, o próprio carregamento
  // (que muda os dois no mesmo render) dispararia um save supérfluo, reescrevendo o arquivo no
  // disco sem nenhuma edição real (o que já bastava para acender "modificado" indevidamente).
  const skipNextSaveRef = useRef(false)

  /** Relê o arquivo do disco (ex.: depois de uma atualização do repositório remoto), descartando um save pendente que o sobrescreveria. */
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
          // Linhas sem nome ainda estão em edição: gravá-las faria o backend recusar o salvamento inteiro.
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

  /** Cria uma cópia do ambiente logo abaixo do original, com ids novos, e a torna ativa. Valores
   * sensíveis são copiados como estão: a cópia fica no mesmo workspace e é cifrada ao salvar. */
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

  /** Reordena a lista de ambientes (arraste ou teclado). A ordem é a do arquivo salvo. */
  const moveEnvironment = useCallback((draggedId: string, targetId: string, edge: SiblingEdge) => {
    setEnvironments((current) => moveById(current, draggedId, targetId, edge))
  }, [])

  /** Reordena as variáveis de um ambiente. Não afeta a resolução: nomes são únicos por ambiente. */
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
      // Sem mudança real, mantém a referência para não disparar um salvamento vazio.
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

  /** Substitui as variáveis do ambiente pelo resultado da edição em massa, preservando id e
   * `sensitive` das linhas que correspondem a uma existente. Um valor igual à máscara mantém o
   * valor original da variável sensível. */
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

  /** Anexa ambientes importados (Postman/Insomnia) ao estado atual — ids de ambiente e de
   * variável são regenerados no cliente, já que os ids que o backend atribui durante a
   * importação (`imported-environment-0`, ...) se repetem a cada chamada e colidiriam entre
   * importações sucessivas ou com ambientes já existentes. */
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

  /** Aplica no ambiente ativo as variáveis gravadas por scripts (`al.environment.set`):
   * atualiza o valor das existentes e cria as novas. O salvamento é o mesmo
   * debounce das demais edições. Sem ambiente ativo, não há onde gravar. */
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

  return {
    environments,
    loaded,
    loadError,
    unreadableSecrets,
    reload,
    activeEnvironmentId,
    activeEnvironment,
    setActiveEnvironmentId,
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
