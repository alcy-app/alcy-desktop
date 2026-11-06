import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cancelGitlabOperation } from '../../bindings/cancel-gitlab-operation'
import { commitAndPush } from '../../bindings/commit-and-push'
import type { ChangeSelectionDto, FileStatusDto, GitlabCommandError, ResolutionInput, StructuredFileChangesDto, WorkspaceLinkDto } from '../../bindings/gitlab-types'
import { getLocalVersionStatus } from '../../bindings/get-local-version-status'
import { getVersionStatus } from '../../bindings/get-version-status'
import { getWorkspaceLink } from '../../bindings/get-workspace-link'
import { linkWorkspace, type LinkTarget } from '../../bindings/link-workspace'
import { pullChanges } from '../../bindings/pull-changes'
import { resolveConflict } from '../../bindings/resolve-conflict'
import { unlinkWorkspace } from '../../bindings/unlink-workspace'
import { useLanguage } from '../../shared/i18n/use-language'
import { countChanges, mergeLocalStatus, summarize } from './version-summary'

/** Reverifica o estado com o remoto enquanto o app está aberto (detecta o que outras pessoas enviaram). */
const REFRESH_INTERVAL_MS = 90_000
/** Evita uma nova consulta a cada foco alternado rapidamente. */
const FOCUS_REFRESH_MIN_INTERVAL_MS = 30_000
/** Depois de um autosave local, espera as edições próximas assentarem antes de
 * verificar — agrupa vários arquivos salvos em sequência numa única consulta. */
const LOCAL_CHANGE_DEBOUNCE_MS = 1_000

export type VersionBusy = 'link' | 'pull' | 'push' | 'resolve' | 'git'

/** What a finished git operation changed, for `runGit`. */
export interface GitOperationEffect {
  /** Files rewritten on disk: the workspace reloads them. */
  files?: string[]
  notice?: string | null
  link?: WorkspaceLinkDto
}

export type LinkParams = LinkTarget & { includeEnvironments: boolean }

type ActionResult = { ok: true } | { ok: false; error: GitlabCommandError }
export type StagedSelection = ChangeSelectionDto


/**
 * Estado de controle de versão do workspace: vínculo, arquivos alterados e as
 * ações (vincular, verificar, atualizar, enviar, resolver). O estado é local ao
 * workbench; só resumos pequenos cruzam o IPC. Com `enabled` falso (feature
 * flag desligada) nem lê o vínculo: o workspace fica como não vinculado e
 * nenhuma verificação roda.
 */
export function useVersionControl(rootPath: string, onFilesChanged: (names: string[]) => void, enabled = true) {
  const { t } = useLanguage()
  const [link, setLink] = useState<WorkspaceLinkDto | null>(null)
  const [linkLoaded, setLinkLoaded] = useState(false)
  const [files, setFiles] = useState<FileStatusDto[] | null>(null)
  const [remoteStatusKnown, setRemoteStatusKnown] = useState(false)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState<VersionBusy | null>(null)
  const [error, setError] = useState<GitlabCommandError | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [statusVersion, setStatusVersion] = useState(0)
  /** Bumped after every git operation, so git views reload their state. */
  const [gitVersion, setGitVersion] = useState(0)

  const operationRef = useRef<string | null>(null)
  const [sessionRoot, setSessionRoot] = useState(rootPath)
  const [message, setMessage] = useState('')
  const [staged, setStaged] = useState<Record<string, StagedSelection>>({})
  const sequenceRef = useRef(0)
  const busyRef = useRef<VersionBusy | null>(null)
  const pollPromiseRef = useRef<Promise<void> | null>(null)
  const pollOperationRef = useRef<string | null>(null)
  const lastRemoteCheckAtRef = useRef(0)
  // Espelha `link !== null` de forma síncrona: uma consulta agendada antes de
  // desvincular não pode recriar o vínculo com um valor antigo do closure.
  const linkedRef = useRef(false)
  const onFilesChangedRef = useRef(onFilesChanged)
  useEffect(() => {
    onFilesChangedRef.current = onFilesChanged
  })

  const linked = link !== null

  const withOperation = useCallback(async <T,>(run: (operationId: string) => Promise<T>): Promise<T> => {
    const operationId = crypto.randomUUID()
    operationRef.current = operationId
    try {
      return await run(operationId)
    } finally {
      if (operationRef.current === operationId) operationRef.current = null
    }
  }, [])

  const cancel = useCallback(() => {
    const operationId = operationRef.current
    if (operationId) void cancelGitlabOperation(operationId)
  }, [])

  if (sessionRoot !== rootPath) {
    setSessionRoot(rootPath)
    setMessage('')
    setStaged({})
    setNotice(null)
    setRemoteStatusKnown(false)
  }

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void getWorkspaceLink(rootPath).then((result) => {
      if (cancelled) return
      linkedRef.current = result.ok && result.value !== null
      setLink(result.ok ? result.value : null)
      setRemoteStatusKnown(false)
      setLinkLoaded(true)
      if (result.ok && result.value !== null) {
        void getLocalVersionStatus(rootPath).then((localResult) => {
          if (cancelled || !linkedRef.current || !localResult.ok) return
          setFiles((current) => current ?? localResult.value)
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [rootPath, enabled])

  /** Consulta remota compartilhada: consumidores simultâneos aguardam a mesma
   * operação, e focos repetidos dentro da janela mínima não geram rede. */
  const pollStatus = useCallback((force = false): Promise<void> => {
    if (!linkedRef.current || busyRef.current !== null) return Promise.resolve()
    if (pollPromiseRef.current) return pollPromiseRef.current
    if (!force && Date.now() - lastRemoteCheckAtRef.current < FOCUS_REFRESH_MIN_INTERVAL_MS) {
      return Promise.resolve()
    }

    const sequence = ++sequenceRef.current
    const operationId = crypto.randomUUID()
    pollOperationRef.current = operationId
    lastRemoteCheckAtRef.current = Date.now()

    const request = getVersionStatus(rootPath, operationId)
      .then((result) => {
        if (sequence !== sequenceRef.current || !linkedRef.current) return
        if (result.ok) {
          setFiles(result.value.files)
          setRemoteStatusKnown(true)
          setStatusVersion((current) => current + 1)
          setLink(result.value.link)
          if (result.value.files.some((file) => file.state !== 'clean')) setNotice(null)
          setError(null)
        } else if (result.error.kind !== 'cancelled') {
          setError(result.error)
        }
      })
      .finally(() => {
        if (pollOperationRef.current === operationId) pollOperationRef.current = null
        if (pollPromiseRef.current === request) pollPromiseRef.current = null
      })
    pollPromiseRef.current = request
    return request
  }, [rootPath])

  /** Verificação pedida pelo usuário ou após uma ação: mostra o indicador de carregamento. */
  const refresh = useCallback(async () => {
    if (!linkedRef.current || busyRef.current !== null) return
    setChecking(true)
    try {
      await pollStatus(true)
    } finally {
      setChecking(false)
    }
  }, [pollStatus])

  const notifyTimeoutRef = useRef<number | null>(null)

  /** Chamado pelos hooks de coleções/ambientes/flows depois que o autosave
   * grava no disco: agenda uma checagem só local (hash local × base salva,
   * sem chamar a API do GitLab) para que "Alterações" reflita a edição na
   * hora, sem gerar uma consulta remota por alteração. Não substitui a
   * verificação periódica/de foco/manual — que segue sendo a única fonte de
   * `remoteChanged`/`conflict` — e o resultado é mesclado sobre o que já se
   * sabia (`mergeLocalStatus`), para não apagar esses dois estados. */
  const notifyLocalChange = useCallback(() => {
    if (!linkedRef.current) return
    if (notifyTimeoutRef.current !== null) window.clearTimeout(notifyTimeoutRef.current)
    notifyTimeoutRef.current = window.setTimeout(() => {
      notifyTimeoutRef.current = null
      if (busyRef.current !== null) return
      void getLocalVersionStatus(rootPath).then((result) => {
        if (!linkedRef.current || !result.ok) return
        setStatusVersion((version) => version + 1)
        setFiles((current) => {
          const next = mergeLocalStatus(current ?? [], result.value)
          if (next.some((file) => file.state !== 'clean')) setNotice(null)
          return next
        })
      })
    }, LOCAL_CHANGE_DEBOUNCE_MS)
  }, [rootPath])

  useEffect(() => {
    return () => {
      if (notifyTimeoutRef.current !== null) window.clearTimeout(notifyTimeoutRef.current)
    }
  }, [])

  useEffect(() => {
    if (!linked) return
    // A primeira consulta é agendada (e não chamada no corpo do efeito) para que
    // o estado só seja atualizado em callbacks, como nas demais consultas.
    const initial = window.setTimeout(() => void pollStatus(true), 0)
    const interval = window.setInterval(() => void pollStatus(), REFRESH_INTERVAL_MS)
    const onFocus = () => void pollStatus()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      const operationId = pollOperationRef.current
      if (operationId) void cancelGitlabOperation(operationId)
    }
  }, [linked, pollStatus])

  /** Executa uma ação de escrita/rede exclusiva, com mensagem de erro e de sucesso. */
  const runAction = useCallback(
    async <T,>(
      kind: VersionBusy,
      run: (operationId: string) => Promise<{ ok: true; value: T } | { ok: false; error: GitlabCommandError }>,
      onSuccess: (value: T) => string | null,
    ): Promise<ActionResult> => {
      if (busyRef.current !== null) return { ok: false, error: { kind: 'cancelled' } }
      busyRef.current = kind
      sequenceRef.current += 1 // descarta uma verificação em voo
      const pollOperationId = pollOperationRef.current
      if (pollOperationId) void cancelGitlabOperation(pollOperationId)
      setBusy(kind)
      setChecking(false)
      setError(null)
      setNotice(null)

      const result = await withOperation(run)

      busyRef.current = null
      setBusy(null)
      if (!result.ok) {
        if (result.error.kind !== 'cancelled') setError(result.error)
        return result
      }
      setNotice(onSuccess(result.value))
      return { ok: true }
    },
    [withOperation],
  )

  const linkTo = useCallback(
    (params: LinkParams) =>
      runAction(
        'link',
        (operationId) => linkWorkspace({ ...params, rootPath, operationId }),
        (status) => {
          linkedRef.current = true
          setLink(status.link)
          setFiles(status.files)
          setRemoteStatusKnown(true)
          setStatusVersion((current) => current + 1)
          return null
        },
      ),
    [rootPath, runAction],
  )

  const unlink = useCallback(async (): Promise<ActionResult> => {
    const result = await unlinkWorkspace(rootPath)
    if (!result.ok) {
      setError(result.error)
      return result
    }
    sequenceRef.current += 1
    linkedRef.current = false
    setLink(null)
    setFiles(null)
    setRemoteStatusKnown(false)
    setError(null)
    setNotice(null)
    setMessage('')
    setStaged({})
    return { ok: true }
  }, [rootPath])

  const pull = useCallback(async () => {
    const result = await runAction(
      'pull',
      (operationId) => pullChanges(rootPath, operationId),
      (pulled) => {
        if (pulled.updated.length > 0) onFilesChangedRef.current(pulled.updated)
        if (pulled.conflicts.length > 0) return t('vc.pull.conflicts', { count: pulled.conflicts.length })
        return pulled.updated.length > 0 ? t('vc.pull.success', { count: pulled.updated.length }) : null
      },
    )
    if (result.ok) void refresh()
    return result
  }, [refresh, rootPath, runAction, t])

  const push = useCallback(
    async (message: string, selections: ChangeSelectionDto[]) => {
      const result = await runAction(
        'push',
        (operationId) => commitAndPush(rootPath, operationId, message, selections),
        (pushed) => t('vc.push.success', { count: pushed.pushed.length }),
      )
      if (result.ok) {
        setMessage('')
        setStaged({})
        void refresh()
      }
      return result
    },
    [refresh, rootPath, runAction, t],
  )

  const resolve = useCallback(
    async (fileName: string, resolution: ResolutionInput) => {
      const result = await runAction(
        'resolve',
        (operationId) => resolveConflict(rootPath, operationId, fileName, resolution),
        (resolved) => {
          if (resolved.localFileChanged) onFilesChangedRef.current([fileName])
          return null
        },
      )
      if (result.ok) void refresh()
      return result
    },
    [refresh, rootPath, runAction],
  )

  /** Runs a git operation (branch, merge, sync…) exclusively, then reloads
   * the files it rewrote and the status. */
  const runGit = useCallback(
    async <T,>(
      run: (operationId: string) => Promise<{ ok: true; value: T } | { ok: false; error: GitlabCommandError }>,
      describe: (value: T) => GitOperationEffect,
    ): Promise<ActionResult> => {
      const result = await runAction('git', run, (value) => {
        const effect = describe(value)
        if (effect.files && effect.files.length > 0) onFilesChangedRef.current(effect.files)
        if (effect.link) setLink(effect.link)
        return effect.notice ?? null
      })
      setGitVersion((version) => version + 1)
      if (result.ok) void refresh()
      return result
    },
    [refresh, runAction],
  )

  const stageFile = useCallback((detail: StructuredFileChangesDto) => {
    setStaged((current) => ({
      ...current,
      [detail.name]: {
        name: detail.name,
        wholeFile: true,
        itemIds: [],
        expectedLocalRevision: detail.localRevision,
        expectedRemoteRevision: detail.remoteRevision,
      },
    }))
  }, [])

  const stageItem = useCallback((detail: StructuredFileChangesDto, itemId: string, allDetails: Record<string, StructuredFileChangesDto>) => {
    setStaged((current) => {
      const next = { ...current }
      const add = (target: StructuredFileChangesDto, id: string) => {
        const existing = next[target.name]
        const sameRevision = existing?.expectedLocalRevision === target.localRevision
          && existing.expectedRemoteRevision === target.remoteRevision
        const itemIds = new Set(sameRevision ? existing.itemIds : [])
        itemIds.add(id)
        next[target.name] = {
          name: target.name,
          wholeFile: false,
          itemIds: [...itemIds],
          expectedLocalRevision: target.localRevision,
          expectedRemoteRevision: target.remoteRevision,
        }
      }
      add(detail, itemId)
      for (const dependency of detail.items.find((item) => item.id === itemId)?.dependencies ?? []) {
        const dependencyDetail = Object.values(allDetails).find((candidate) => candidate.items.some((item) => item.id === dependency))
        if (dependencyDetail) add(dependencyDetail, dependency)
      }
      return next
    })
  }, [])

  const unstageFile = useCallback((fileName: string, allDetails: Record<string, StructuredFileChangesDto> = {}) => {
    setStaged((current) => {
      const next = { ...current }
      const removedIds = new Set(allDetails[fileName]?.items.map((item) => item.id) ?? [])
      delete next[fileName]
      if (removedIds.size === 0) return next
      for (const candidate of Object.values(allDetails)) {
        const existing = next[candidate.name]
        if (!existing) continue
        const ids = new Set(existing.wholeFile ? candidate.items.map((item) => item.id) : existing.itemIds)
        for (const flow of candidate.items.filter((item) => item.itemKind === 'flow' && item.dependencies.some((id) => removedIds.has(id)))) {
          ids.delete(flow.id)
        }
        if (ids.size === 0) delete next[candidate.name]
        else next[candidate.name] = { ...existing, wholeFile: false, itemIds: [...ids] }
      }
      return next
    })
  }, [])

  const unstageItem = useCallback((detail: StructuredFileChangesDto, itemId: string, allDetails: Record<string, StructuredFileChangesDto>) => {
    setStaged((current) => {
      const next = { ...current }
      const remove = (candidate: StructuredFileChangesDto, id: string) => {
        const existing = next[candidate.name]
        if (!existing) return
        const ids = new Set(existing.wholeFile ? candidate.items.map((item) => item.id) : existing.itemIds)
        ids.delete(id)
        if (ids.size === 0) delete next[candidate.name]
        else next[candidate.name] = { ...existing, wholeFile: false, itemIds: [...ids] }
      }
      remove(detail, itemId)
      for (const candidate of Object.values(allDetails)) {
        for (const flow of candidate.items.filter((item) => item.itemKind === 'flow' && item.dependencies.includes(itemId))) {
          remove(candidate, flow.id)
        }
      }
      return next
    })
  }, [])

  const reconcileStaged = useCallback((detail: StructuredFileChangesDto) => {
    const existing = staged[detail.name]
    const sameRevision = existing?.expectedLocalRevision === detail.localRevision
      && existing.expectedRemoteRevision === detail.remoteRevision
    if (!existing || sameRevision) return
    setStaged((current) => {
      const next = { ...current }
      delete next[detail.name]
      return next
    })
    setNotice(t('vc.stage.invalidated', { file: detail.name }))
  }, [staged, t])

  const clearMessages = useCallback(() => {
    setError(null)
    setNotice(null)
  }, [])

  const counts = useMemo(() => countChanges(files ?? []), [files])
  const stagedSelections = useMemo(() => Object.values(staged), [staged])
  const summary = summarize({
    linked,
    loaded: linkLoaded,
    statusKnown: files !== null,
    remoteStatusKnown,
    busy: busy !== null,
    failed: error !== null,
    counts,
  })

  // Identidade estável enquanto nada muda: o objeto chega a componentes
  // `memo` (sidebar) e, recriado a cada render do workbench, os faria
  // renderizar de novo a cada tecla digitada no editor.
  return useMemo(
    () => ({
      linkLoaded,
      link,
      files: files ?? NO_FILES,
      counts,
      summary,
      checking,
      busy,
      error,
      notice,
      message,
      setMessage,
      statusVersion,
      gitVersion,
      runGit,
      staged,
      stagedSelections,
      stageFile,
      stageItem,
      unstageFile,
      unstageItem,
      reconcileStaged,
      refresh,
      notifyLocalChange,
      cancel,
      linkTo,
      unlink,
      pull,
      push,
      resolve,
      clearMessages,
    }),
    [
      linkLoaded,
      link,
      files,
      counts,
      summary,
      checking,
      busy,
      error,
      notice,
      message,
      statusVersion,
      gitVersion,
      runGit,
      staged,
      stagedSelections,
      stageFile,
      stageItem,
      unstageFile,
      unstageItem,
      reconcileStaged,
      refresh,
      notifyLocalChange,
      cancel,
      linkTo,
      unlink,
      pull,
      push,
      resolve,
      clearMessages,
    ],
  )
}

const NO_FILES: FileStatusDto[] = []

export type VersionControl = ReturnType<typeof useVersionControl>
