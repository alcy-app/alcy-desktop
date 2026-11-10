import { useCallback, useEffect, useRef, useState } from 'react'
import type { AuthenticationInput, ScopedVariableChange } from '../../bindings/execute-graphql-request'
import { exportCollections } from '../../bindings/export-collections'
import { importCollections } from '../../bindings/import-collections'
import type { EnvironmentMergeDto, ImportedCollectionDataDto } from '../../bindings/import-collections'
import { importCollectionsFromText } from '../../bindings/import-collections-from-text'
import { importCollectionsFromUrl } from '../../bindings/import-collections-from-url'
import { listCollections } from '../../bindings/list-collections'
import {
  commitPreparedImport,
  prepareImportFromPath,
  prepareImportFromText,
  prepareImportFromUrl,
  type ImportVariableSelectionDto,
} from '../../bindings/prepared-import'
import type {
  CollectionDto,
  CollectionLabelDto,
  FolderDto,
  LabelColor,
  SavedRequestDto,
  ScopedVariableDto,
} from '../../bindings/list-collections'
import type { EnvironmentDto } from '../../bindings/list-environments'
import { registerBeforeExit } from '../../shared/app-lifecycle/before-exit'
import { pickExportFile } from '../../bindings/pick-export-file'
import { saveCollections } from '../../bindings/save-collections'
import { useCommittedState } from '../../shared/use-committed-state'
import { useLanguage } from '../../shared/i18n/use-language'
import { useToast } from '../../shared/ui/use-toast'
import type { SiblingEdge } from '../../shared/use-pointer-drag'
import { emptyRestBody, restBodyFromDto, restBodyText } from './body-state'
import { assignCollectionLabel, recolorLabelEverywhere, removeLabelEverywhere, renameLabelEverywhere } from './collection-labels'
import {
  allFolderIds,
  sortNodeChildren,
  topLevelSelection,
  duplicateRequest as duplicateRequestInTree,
  createExample,
  emptyExampleResponse,
  emptyRequestContent,
  findAncestorIds,
  findExample,
  findNode,
  findRequest,
  insertExample,
  insertFolder,
  insertRequest,
  kindOf,
  moveFolder as moveFolderInTree,
  moveItems,
  moveRequest as moveRequestInTree,
  regenerateIds,
  removeNode,
  removeNodes,
  renameNode,
  updateNodeAuthentication,
  updateNodeVariables,
  applyScopedChanges as applyScopedChangesInTree,
  reorderCollections as reorderCollectionsInTree,
  reorderFolder as reorderFolderInTree,
  reorderRequest as reorderRequestInTree,
  uniqueChildName,
  uniqueExampleName,
  uniqueSiblingName,
  updateExample as updateExampleInTree,
  updateRequestContent as updateRequestContentInTree,
} from './collection-tree'
import type { ExampleResponse, RequestContent, RequestExample, RequestProtocol, RequestSummary, TreeNode } from './collection-tree'
import type { AlphabeticalSortDirection } from './collection-tree'
import { emptyGrpcCall, websocketCallDto, websocketFromDto, websocketOf } from './collection-tree'

const SAVE_DEBOUNCE_MS = 500

/** An import attempt result. Callers choose how to present failures; import dialogs keep them inline for correction and retry. */
/** Imported scripts are preserved without execution; incompatible counts commands replaced by an explicit error. */
export type ImportScriptStats = { count: number; incompatible: number }

export type ImportOutcome = { ok: true; scripts?: ImportScriptStats } | { ok: false; message: string }

/** The backend only knows `graphql`/`rest`/`grpc`/`websocket` (it rejects
 * any other protocol when loading), so the cast is safe. */
export function requestFromDto(dto: SavedRequestDto): RequestSummary {
  const protocol = dto.protocol as RequestProtocol

  return {
    id: dto.id,
    name: dto.name,
    protocol,
    ...(dto.docsRef ? { docsRef: dto.docsRef } : {}),
    ...(dto.examples?.length
      ? {
          examples: dto.examples.map((example) => ({
            id: example.request.id,
            name: example.request.name,
            content: requestFromDto(example.request).content,
            response: example.response,
          })),
        }
      : {}),
    content:
      protocol === 'websocket'
        ? {
            protocol: 'websocket',
            endpointUrl: dto.endpoint,
            query: '',
            variables: '',
            method: dto.method,
            body: emptyRestBody,
            headers: dto.headers,
            authentication: dto.authentication,
            preRequestScript: dto.preRequestScript ?? '',
            postResponseScript: dto.postResponseScript ?? '',
            routeParams: dto.routeParams ?? [],
            grpc: emptyGrpcCall,
            websocket: websocketFromDto(dto.websocket, dto.body),
          }
        : protocol === 'grpc'
        ? {
            protocol: 'grpc',
            endpointUrl: dto.endpoint,
            query: '',
            variables: '',
            method: dto.method,
            body: emptyRestBody,
            headers: dto.headers,
            authentication: dto.authentication,
            preRequestScript: dto.preRequestScript ?? '',
            postResponseScript: dto.postResponseScript ?? '',
            routeParams: [],
            grpc: {
              service: dto.grpc?.service ?? '',
              method: dto.grpc?.method ?? '',
              schemaSource: dto.grpc?.schemaSource ?? emptyGrpcCall.schemaSource,
              deadlineMs: dto.grpc?.deadlineMs ?? null,
              message: dto.body,
            },
          }
        : protocol === 'rest'
        ? {
            protocol: 'rest',
            endpointUrl: dto.endpoint,
            query: '',
            variables: '',
            method: dto.method,
            body: restBodyFromDto(dto.restBody, dto.body),
            headers: dto.headers,
            authentication: dto.authentication,
            preRequestScript: dto.preRequestScript ?? '',
            postResponseScript: dto.postResponseScript ?? '',
            routeParams: dto.routeParams ?? [],
            grpc: emptyGrpcCall,
          }
        : {
            protocol: 'graphql',
            endpointUrl: dto.endpoint,
            query: dto.body,
            variables: dto.variables,
            method: dto.method,
            body: emptyRestBody,
            headers: dto.headers,
            authentication: dto.authentication,
            preRequestScript: dto.preRequestScript ?? '',
            postResponseScript: dto.postResponseScript ?? '',
            routeParams: [],
            grpc: emptyGrpcCall,
          },
  }
}

/** The document body a saved request carries on the wire, per protocol. */
function bodyTextOf(content: RequestSummary['content']): string {
  switch (content.protocol) {
    case 'rest':
      return restBodyText(content.body)
    case 'grpc':
      return content.grpc.message
    case 'websocket':
      return websocketOf(content).message
    case 'graphql':
      return content.query
  }
}

/** The wire body is the GraphQL query or REST body. RequestContent preserves both protocol configurations, but only the selected protocol is active. */
export function requestToDto(request: RequestSummary): SavedRequestDto {
  return {
    id: request.id,
    name: request.name,
    protocol: request.protocol,
    endpoint: request.content.endpointUrl,
    method: request.content.method,
    body: bodyTextOf(request.content),
    restBody: request.content.protocol === 'rest' ? request.content.body : null,
    variables: request.content.variables,
    headers: request.content.headers,
    authentication: request.content.authentication,
    preRequestScript: request.content.preRequestScript,
    postResponseScript: request.content.postResponseScript,
    routeParams: request.content.routeParams,
    ...(request.docsRef ? { docsRef: request.docsRef } : {}),
    ...(request.examples?.length
      ? {
          examples: request.examples.map((example) => ({
            request: requestToDto({ id: example.id, name: example.name, protocol: example.content.protocol, content: example.content }),
            response: example.response,
          })),
        }
      : {}),
    ...(request.content.protocol === 'grpc'
      ? {
          grpc: {
            service: request.content.grpc.service,
            method: request.content.grpc.method,
            schemaSource: request.content.grpc.schemaSource,
            deadlineMs: request.content.grpc.deadlineMs,
          },
        }
      : {}),
    ...(request.content.protocol === 'websocket'
      ? { websocket: websocketCallDto(websocketOf(request.content)) }
      : {}),
  }
}

export function treeFromDto(nodes: (CollectionDto | FolderDto)[]): TreeNode[] {
  return nodes.map((node) => ({
    id: node.id,
    name: node.name,
    folders: treeFromDto(node.folders),
    requests: node.requests.map(requestFromDto),
    authentication: node.authentication,
    variables: node.variables ?? [],
    ...('labels' in node && node.labels?.length ? { labels: node.labels } : {}),
  }))
}

/** Collections and folders share this conversion; only root collections have labels. */
function folderDtoFromNode(node: TreeNode): CollectionDto {
  return {
    id: node.id,
    name: node.name,
    folders: node.folders.map(folderDtoFromNode),
    requests: node.requests.map(requestToDto),
    authentication: node.authentication,
    variables: node.variables,
    ...(node.labels?.length ? { labels: node.labels } : {}),
  }
}

function importScriptStats(data: ImportedCollectionDataDto): ImportScriptStats | undefined {
  const count = data.scriptCount ?? 0
  if (count === 0) return undefined
  return { count, incompatible: (data.warnings ?? []).length }
}

export function useCollectionsState(
  workspaceRootPath: string,
  onImportEnvironments: (dtos: EnvironmentDto[], merges: EnvironmentMergeDto[]) => void,
  onSaved?: () => void,
) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [collections, setCollections] = useState<TreeNode[]>([])
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [loaded, setLoaded] = useState(false)
  // Do not save after a failed load; an empty UI must never overwrite an unreadable or newer collection file.
  const [loadError, setLoadError] = useState<string | null>(null)
  const saveTimeoutRef = useRef<number | null>(null)
  const pendingSaveRef = useRef<{ workspaceRootPath: string; body: CollectionDto[] } | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  // Loading collections and the loaded flag together must not cause redundant persistence or false change markers.
  const skipNextSaveRef = useRef(false)

  /** An edit still waiting for its autosave; reloading now would discard it. */
  const hasPendingSave = useCallback(() => saveTimeoutRef.current !== null, [])

  /** Reload from disk and cancel pending saves that could overwrite externally updated content. */
  const reload = useCallback(() => {
    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    pendingSaveRef.current = null
    setReloadToken((token) => token + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    skipNextSaveRef.current = true

    void listCollections(workspaceRootPath).then((result) => {
      if (cancelled) return
      if (result.ok) setCollections(treeFromDto(result.value))
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

    const body = collections.map(folderDtoFromNode)
    pendingSaveRef.current = { workspaceRootPath, body }

    saveTimeoutRef.current = window.setTimeout(() => {
      saveTimeoutRef.current = null
      pendingSaveRef.current = null
      void saveCollections(workspaceRootPath, body).then(() => onSaved?.())
    }, SAVE_DEBOUNCE_MS)

    return () => {
      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [collections, loaded, loadError, workspaceRootPath, onSaved])

  /** Flush the pending collection write before shutdown or commands that reload collections from disk. */
  const flushPendingSave = useCallback(async () => {
    if (saveTimeoutRef.current === null || pendingSaveRef.current === null) return
    window.clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = null
    const pending = pendingSaveRef.current
    pendingSaveRef.current = null
    await saveCollections(pending.workspaceRootPath, pending.body)
  }, [])

  /** Flush pending edits when leaving the workspace or closing the app. Scope cleanup to workspace lifetime rather than every collection edit. */
  useEffect(() => {
    // Window closing and update restarts both use runBeforeExit.
    const unregisterBeforeExit = registerBeforeExit(flushPendingSave)

    return () => {
      void flushPendingSave()
      unregisterBeforeExit()
    }
  }, [workspaceRootPath, flushPendingSave])

  const commitCollections = useCommittedState({
    scope: workspaceRootPath,
    value: collections, ready: loaded, error: loadError,
    cancelPending: () => {
      if (saveTimeoutRef.current !== null) window.clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
      pendingSaveRef.current = null
    },
    persist: async (next) => {
      const result = await saveCollections(workspaceRootPath, next.map(folderDtoFromNode))
      if (!result.ok) throw new Error(result.error.message)
      onSaved?.()
    },
    apply: (next) => { skipNextSaveRef.current = true; setCollections([...next]) },
    restorePending: () => setCollections((current) => [...current]),
  })

  const expand = useCallback((id: string) => {
    setExpandedIds((current) => new Set(current).add(id))
  }, [])

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const collapseAll = useCallback(() => {
    setExpandedIds(new Set())
  }, [])

  const expandAll = useCallback(() => {
    setExpandedIds(allFolderIds(collections))
  }, [collections])

  /** Expand the request's ancestor folders while preserving the rest of the tree. */
  const revealRequest = useCallback(
    (id: string) => {
      const ancestors = findAncestorIds(collections, id)
      if (!ancestors) return
      setExpandedIds((current) => new Set([...current, ...ancestors]))
    },
    [collections],
  )

  const addCollection = useCallback((name?: string) => {
    const id = crypto.randomUUID()
    const baseName = name?.trim() || t('collections.newCollectionName')
    setCollections((current) =>
      insertFolder(current, null, {
        id,
        name: uniqueChildName(current, null, 'folder', baseName),
        folders: [],
        requests: [],
        authentication: { type: 'inherit' },
        variables: [],
      }),
    )
    return id
  }, [t])

  const addFolder = useCallback(
    (parentId: string, name?: string) => {
      const id = crypto.randomUUID()
      const baseName = name?.trim() || t('collections.newFolderName')
      setCollections((current) =>
        insertFolder(current, parentId, {
          id,
          name: uniqueChildName(current, parentId, 'folder', baseName),
          folders: [],
          requests: [],
          authentication: { type: 'inherit' },
          variables: [],
        }),
      )
      expand(parentId)
      return id
    },
    [t, expand],
  )

  const addRequest = useCallback(
    (parentId: string, name: string, protocol: RequestProtocol, content: RequestContent = emptyRequestContent(protocol)) => {
      const id = crypto.randomUUID()
      const finalName = name.trim() || t('collections.newRequestName')
      setCollections((current) => insertRequest(current, parentId, { id, name: finalName, protocol, content }))
      expand(parentId)
      return { id, name: finalName }
    },
    [t, expand],
  )

  const duplicateRequest = useCallback(
    (id: string) => {
      const newId = crypto.randomUUID()
      const original = findRequest(collections, id)
      const name = original
        ? uniqueSiblingName(collections, id, 'request', `${original.name} ${t('collections.copySuffix')}`)
        : t('collections.newRequestName')

      setCollections((current) => duplicateRequestInTree(current, id, newId, name))
      showToast(t('toasts.requestDuplicated'))

      return { id: newId, name, content: original?.content ?? emptyRequestContent('graphql') }
    },
    [collections, t, showToast],
  )

  /** Add an example under a request and show it in the tree. Content defaults to the saved request's. */
  const addExample = useCallback(
    (requestId: string, content?: RequestContent, response: ExampleResponse = emptyExampleResponse): RequestExample | null => {
      const request = findRequest(collections, requestId)
      if (!request) return null
      const example = createExample(crypto.randomUUID(), uniqueExampleName(request, request.name), content ?? request.content, response)
      setCollections((current) => insertExample(current, requestId, example))
      expand(requestId)
      return example
    },
    [collections, expand],
  )

  const duplicateExample = useCallback(
    (id: string): { requestId: string; example: RequestExample } | null => {
      const found = findExample(collections, id)
      if (!found) return null
      const name = uniqueExampleName(found.request, `${found.example.name} ${t('collections.copySuffix')}`)
      const example = { ...found.example, id: crypto.randomUUID(), name }
      setCollections((current) => insertExample(current, found.request.id, example, id))
      return { requestId: found.request.id, example }
    },
    [collections, t],
  )

  const updateExample = useCallback((example: RequestExample) => {
    setCollections((current) => updateExampleInTree(current, example))
  }, [])

  const moveRequest = useCallback(
    (id: string, targetParentId: string) => {
      setCollections((current) => moveRequestInTree(current, id, targetParentId))
      expand(targetParentId)
    },
    [expand],
  )

  const reorderRequest = useCallback((id: string, targetId: string, edge: SiblingEdge) => {
    setCollections((current) => reorderRequestInTree(current, id, targetId, edge))
  }, [])

  const moveFolder = useCallback(
    (id: string, targetParentId: string) => {
      setCollections((current) => moveFolderInTree(current, id, targetParentId))
      expand(targetParentId)
    },
    [expand],
  )

  const reorderFolder = useCallback((id: string, targetId: string, edge: SiblingEdge) => {
    setCollections((current) => reorderFolderInTree(current, id, targetId, edge))
  }, [])

  const reorderCollections = useCallback((id: string, targetId: string, edge: SiblingEdge) => {
    setCollections((current) => reorderCollectionsInTree(current, id, targetId, edge))
  }, [])

  const sortChildren = useCallback((id: string, direction: AlphabeticalSortDirection) => {
    setCollections((current) => sortNodeChildren(current, id, direction))
  }, [])

  const rename = useCallback((id: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return

    // Sibling requests may share names; only folder and collection names are deduplicated.
    setCollections((current) =>
      renameNode(current, id, kindOf(current, id) === 'folder' ? uniqueSiblingName(current, id, 'folder', trimmed) : trimmed),
    )
  }, [])

  const updateAuthentication = useCallback((id: string, authentication: AuthenticationInput) => {
    setCollections((current) => updateNodeAuthentication(current, id, authentication))
  }, [])

  const updateVariables = useCallback((id: string, variables: ScopedVariableDto[]) => {
    setCollections((current) => updateNodeVariables(current, id, variables))
  }, [])

  /** Collection labels support bulk assignment and global management (ADR 0060). */
  const assignLabel = useCallback((ids: string[], label: CollectionLabelDto, assigned: boolean) => {
    setCollections((current) => assignCollectionLabel(current, ids, label, assigned))
  }, [])

  const renameLabel = useCallback((oldName: string, newName: string) => {
    setCollections((current) => renameLabelEverywhere(current, oldName, newName))
  }, [])

  const recolorLabel = useCallback((name: string, color: LabelColor) => {
    setCollections((current) => recolorLabelEverywhere(current, name, color))
  }, [])

  const removeLabel = useCallback((name: string) => {
    setCollections((current) => removeLabelEverywhere(current, name))
  }, [])

  /** Apply script writes to collection and folder variables; leave state and persistence untouched when there are no writes. */
  const applyScopedChanges = useCallback((changes: ScopedVariableChange[]) => {
    if (changes.length === 0) return
    setCollections((current) => applyScopedChangesInTree(current, changes))
  }, [])

  const remove = useCallback((id: string) => {
    setCollections((current) => removeNode(current, id))
    setExpandedIds((current) => {
      const next = new Set(current)
      next.delete(id)
      return next
    })
  }, [])

  /** Remove a multiple selection in one update (spec 0104). */
  const removeMany = useCallback((ids: string[]) => {
    setCollections((current) => removeNodes(current, ids))
    setExpandedIds((current) => {
      const next = new Set(current)
      for (const id of ids) next.delete(id)
      return next
    })
  }, [])

  const moveMany = useCallback(
    (ids: string[], targetParentId: string) => {
      setCollections((current) => moveItems(current, ids, targetParentId))
      expand(targetParentId)
    },
    [expand],
  )

  /** Persist explicit flow-editor saves before the execution engine reloads collections. */
  const saveRequestContents = useCallback(async (updates: { id: string; content: RequestContent }[]) => {
    if (!loaded || loadError !== null) throw new Error(loadError ?? 'Collections are not loaded')
    const next = updates.reduce((tree, update) => updateRequestContentInTree(tree, update.id, update.content), collections)
    if (saveTimeoutRef.current !== null) window.clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = null
    pendingSaveRef.current = null
    const result = await saveCollections(workspaceRootPath, next.map(folderDtoFromNode))
    if (!result.ok) throw new Error(result.error.message)
    setCollections(next)
    onSaved?.()
  }, [collections, loaded, loadError, workspaceRootPath, onSaved])

  const updateRequestContent = useCallback((id: string, content: RequestContent) => {
    setCollections((current) => updateRequestContentInTree(current, id, content))
  }, [])

  const exportCollection = useCallback(
    async (id: string) => {
      const node = findNode(collections, id)
      if (!node) return
      const path = await pickExportFile(node.name || t('collections.newCollectionName'))
      if (path === null) return

      const result = await exportCollections(path, [folderDtoFromNode(node)])
      if (result.ok) {
        showToast(t('toasts.collectionExported'))
      } else {
        showToast(t('collections.importExportError', { message: result.error.message }), 'error')
      }
    },
    [collections, t, showToast],
  )

  /** Export selected collections and folders into one file, excluding selected descendants. */
  const exportCollectionsByIds = useCallback(
    async (ids: string[]) => {
      const nodes = topLevelSelection(collections, new Set(ids))
        .map((id) => findNode(collections, id))
        .filter((node): node is TreeNode => node !== null)
      if (nodes.length === 0) return
      const defaultName =
        nodes.length === 1 ? nodes[0].name || t('collections.newCollectionName') : t('collections.exportAllFileName')
      const path = await pickExportFile(defaultName)
      if (path === null) return

      const result = await exportCollections(path, nodes.map(folderDtoFromNode))
      if (result.ok) {
        showToast(t(nodes.length === 1 ? 'toasts.collectionExported' : 'toasts.collectionsExported'))
      } else {
        showToast(t('collections.importExportError', { message: result.error.message }), 'error')
      }
    },
    [collections, t, showToast],
  )

  /** Export the selected folder with its root collection so inherited variables and authentication remain available to the webclient (spec 0113). */
  const webclientSelection = useCallback(
    (id: string): { collection: CollectionDto; folderId: string | null; name: string } | null => {
      const root = collections.find((collection) => findNode([collection], id) !== null)
      const node = root ? findNode([root], id) : null
      if (!root || !node) return null
      return { collection: folderDtoFromNode(root), folderId: root.id === id ? null : id, name: node.name }
    },
    [collections],
  )

  const exportAll = useCallback(async () => {
    const path = await pickExportFile(t('collections.exportAllFileName'))
    if (path === null) return

    const result = await exportCollections(path, collections.map(folderDtoFromNode))
    if (result.ok) {
      showToast(t('toasts.collectionsExported'))
    } else {
      showToast(t('collections.importExportError', { message: result.error.message }), 'error')
    }
  }, [collections, t, showToast])

  const applyImportedCollections = useCallback(
    (data: ImportedCollectionDataDto, notify = true) => {
      setCollections((current) => {
        let next = current
        for (const dto of data.collections) {
          const imported = regenerateIds(treeFromDto([dto])[0])
          next = insertFolder(next, null, {
            ...imported,
            name: uniqueChildName(next, null, 'folder', imported.name),
          })
        }
        return next
      })
      const environments = data.environments ?? []
      const merges = data.environmentMerges ?? []
      if (environments.length > 0 || merges.length > 0) onImportEnvironments(environments, merges)
      if (notify) showToast(t('toasts.collectionsImported'))
    },
    [t, showToast, onImportEnvironments],
  )

  const importCollectionsFromPath = useCallback(
    async (path: string): Promise<ImportOutcome> => {
      const result = await importCollections(path, workspaceRootPath)
      if (!result.ok) return { ok: false, message: result.error.message }
      applyImportedCollections(result.value)
      return { ok: true, scripts: importScriptStats(result.value) }
    },
    [applyImportedCollections, workspaceRootPath],
  )

  const importCollectionsFromUrlSource = useCallback(
    async (url: string): Promise<ImportOutcome> => {
      const result = await importCollectionsFromUrl(url, workspaceRootPath)
      if (!result.ok) return { ok: false, message: result.error.message }
      applyImportedCollections(result.value)
      return { ok: true, scripts: importScriptStats(result.value) }
    },
    [applyImportedCollections, workspaceRootPath],
  )

  const importCollectionsFromTextSource = useCallback(
    async (content: string): Promise<ImportOutcome> => {
      const result = await importCollectionsFromText(content, workspaceRootPath)
      if (!result.ok) return { ok: false, message: result.error.message }
      applyImportedCollections(result.value)
      return { ok: true, scripts: importScriptStats(result.value) }
    },
    [applyImportedCollections, workspaceRootPath],
  )

  const prepareCollectionsFromPath = useCallback(
    (path: string) => prepareImportFromPath(path, workspaceRootPath),
    [workspaceRootPath],
  )

  const prepareCollectionsFromUrl = useCallback(
    (url: string) => prepareImportFromUrl(url, workspaceRootPath),
    [workspaceRootPath],
  )

  const prepareCollectionsFromText = useCallback(
    (content: string) => prepareImportFromText(content, workspaceRootPath),
    [workspaceRootPath],
  )

  const commitPreparedCollection = useCallback(
    async (id: string, includeDocumentation: boolean, variables?: ImportVariableSelectionDto[]): Promise<ImportOutcome> => {
      const result = await commitPreparedImport(id, workspaceRootPath, includeDocumentation, variables)
      if (!result.ok) return { ok: false, message: result.error.message }
      applyImportedCollections(result.value, false)
      return { ok: true, scripts: importScriptStats(result.value) }
    },
    [applyImportedCollections, workspaceRootPath],
  )

  return {
    commitCollections,
    collections,
    loaded,
    loadError,
    reload,
    hasPendingSave,
    expandedIds,
    toggleExpanded,
    collapseAll,
    expandAll,
    revealRequest,
    addCollection,
    addFolder,
    addRequest,
    duplicateRequest,
    addExample,
    duplicateExample,
    updateExample,
    moveRequest,
    reorderRequest,
    moveFolder,
    reorderFolder,
    reorderCollections,
    sortChildren,
    rename,
    updateAuthentication,
    updateVariables,
    assignLabel,
    renameLabel,
    recolorLabel,
    removeLabel,
    applyScopedChanges,
    remove,
    removeMany,
    moveMany,
    updateRequestContent,
    saveRequestContents,
    exportCollection,
    exportCollectionsByIds,
    exportAll,
    webclientSelection,
    importCollectionsFromPath,
    importCollectionsFromUrl: importCollectionsFromUrlSource,
    importCollectionsFromText: importCollectionsFromTextSource,
    prepareCollectionsFromPath,
    prepareCollectionsFromUrl,
    prepareCollectionsFromText,
    commitPreparedCollection,
    flush: flushPendingSave,
  }
}
