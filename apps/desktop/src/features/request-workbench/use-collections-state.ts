import { useCallback, useEffect, useRef, useState } from 'react'
import type { AuthenticationInput, ScopedVariableChange } from '../../bindings/execute-graphql-request'
import { exportCollections } from '../../bindings/export-collections'
import { importCollections } from '../../bindings/import-collections'
import type { ImportedCollectionDataDto } from '../../bindings/import-collections'
import { importCollectionsFromText } from '../../bindings/import-collections-from-text'
import { importCollectionsFromUrl } from '../../bindings/import-collections-from-url'
import { listCollections } from '../../bindings/list-collections'
import {
  commitPreparedImport,
  prepareImportFromPath,
  prepareImportFromText,
  prepareImportFromUrl,
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
import { useLanguage } from '../../shared/i18n/use-language'
import { useToast } from '../../shared/ui/use-toast'
import type { SiblingEdge } from '../../shared/use-pointer-drag'
import { emptyRestBody, restBodyFromDto, restBodyText } from './body-state'
import { assignCollectionLabel, recolorLabelEverywhere, removeLabelEverywhere, renameLabelEverywhere } from './collection-labels'
import {
  allFolderIds,
  sortNodeChildren,
  duplicateRequest as duplicateRequestInTree,
  emptyRequestContent,
  findAncestorIds,
  findNode,
  findRequest,
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
  uniqueSiblingName,
  updateRequestContent as updateRequestContentInTree,
} from './collection-tree'
import type { RequestContent, RequestProtocol, RequestSummary, TreeNode } from './collection-tree'
import type { AlphabeticalSortDirection } from './collection-tree'

const SAVE_DEBOUNCE_MS = 500

/** Resultado de uma tentativa de importar (por arquivo, URL ou texto
 * colado) — quem chama decide o que fazer com o erro (a modal de importar
 * mostra inline, para o usuário poder corrigir e tentar de novo). */
/** Scripts trazidos pela importação: importados, mas nunca executados; `incompatible` conta os comandos
 * sem tradução, trocados por um erro explícito. */
export type ImportScriptStats = { count: number; incompatible: number }

export type ImportOutcome = { ok: true; scripts?: ImportScriptStats } | { ok: false; message: string }

/** O backend só reconhece `graphql`/`rest`; qualquer outro valor não deveria
 * ter passado pela validação de domínio antes de chegar aqui. */
export function requestFromDto(dto: SavedRequestDto): RequestSummary {
  const protocol = dto.protocol as RequestProtocol

  return {
    id: dto.id,
    name: dto.name,
    protocol,
    ...(dto.docsRef ? { docsRef: dto.docsRef } : {}),
    content:
      protocol === 'rest'
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
          },
  }
}

/** `body` (campo único no wire) vem de `content.query` para GraphQL e de
 * `content.body` para REST — os dois pares (`query`/`variables` vs.
 * `method`/`body`) coexistem em `RequestContent`, mas só um é relevante
 * por protocolo. */
export function requestToDto(request: RequestSummary): SavedRequestDto {
  return {
    id: request.id,
    name: request.name,
    protocol: request.protocol,
    endpoint: request.content.endpointUrl,
    method: request.content.method,
    body: request.content.protocol === 'rest' ? restBodyText(request.content.body) : request.content.query,
    restBody: request.content.protocol === 'rest' ? request.content.body : null,
    variables: request.content.variables,
    headers: request.content.headers,
    authentication: request.content.authentication,
    preRequestScript: request.content.preRequestScript,
    postResponseScript: request.content.postResponseScript,
    routeParams: request.content.routeParams,
    ...(request.docsRef ? { docsRef: request.docsRef } : {}),
  }
}

function treeFromDto(nodes: (CollectionDto | FolderDto)[]): TreeNode[] {
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

/** Serve para collections e pastas: `labels` só sai quando houver rótulos, que só existem na raiz. */
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
  onImportEnvironments: (dtos: EnvironmentDto[]) => void,
  onSaved?: () => void,
) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [collections, setCollections] = useState<TreeNode[]>([])
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [loaded, setLoaded] = useState(false)
  // Arquivo que não foi lido (ex.: gravado por uma versão mais nova do app): enquanto houver erro,
  // nada é salvo, para não trocar o conteúdo do disco pela lista vazia mostrada na tela.
  const [loadError, setLoadError] = useState<string | null>(null)
  const saveTimeoutRef = useRef<number | null>(null)
  const pendingSaveRef = useRef<{ workspaceRootPath: string; body: CollectionDto[] } | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  // O efeito de salvar reage a `collections`/`loaded` juntos — sem isso, o próprio carregamento
  // (que muda os dois no mesmo render) dispararia um save supérfluo, reescrevendo o arquivo no
  // disco sem nenhuma edição real (o que já bastava para acender "modificado" indevidamente).
  const skipNextSaveRef = useRef(false)

  /** Relê o arquivo do disco (ex.: depois de uma atualização do repositório remoto), descartando um save pendente que o sobrescreveria. */
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

  /** Grava agora o save debounced pendente, se houver. Resolve quando a
   * gravação termina: quem encerra o app, ou quem vai ler as coleções do
   * disco (ex.: o runner), aguarda por ela. */
  const flushPendingSave = useCallback(async () => {
    if (saveTimeoutRef.current === null || pendingSaveRef.current === null) return
    window.clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = null
    const pending = pendingSaveRef.current
    pendingSaveRef.current = null
    await saveCollections(pending.workspaceRootPath, pending.body)
  }, [])

  /** Um save debounced pendente não pode ser só cancelado ao trocar de
   * workspace, desmontar ou fechar o app — isso perderia a última edição
   * silenciosamente. Escopado a `workspaceRootPath` (não a `collections`)
   * para que o cleanup só dispare nesses casos reais, não a cada tecla. */
  useEffect(() => {
    // Fechar a janela e reiniciar para instalar uma atualização passam por `runBeforeExit`.
    const unregisterBeforeExit = registerBeforeExit(flushPendingSave)

    return () => {
      void flushPendingSave()
      unregisterBeforeExit()
    }
  }, [workspaceRootPath, flushPendingSave])

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

  /** Expande as pastas que contêm a requisição, sem mexer no restante da árvore. */
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

    // Requisições irmãs podem ter o mesmo nome; só pastas/coleções são deduplicadas.
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

  /** Rótulos de collection (ADR 0060): ligar/desligar em uma ou várias collections e gerenciar em todas. */
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

  /** Aplica gravações de script em variáveis de coleção/pasta; sem nada gravado, não toca no estado (nem no disco). */
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

  /** Remoção em lote da seleção múltipla (spec 0104). */
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

  /** Exporta várias coleções num único arquivo (seleção múltipla, spec 0104). */
  const exportCollectionsByIds = useCallback(
    async (ids: string[]) => {
      const nodes = ids
        .map((id) => collections.find((collection) => collection.id === id))
        .filter((node): node is TreeNode => node !== undefined)
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

  /** Coleção raiz que contém `id` (uma coleção ou pasta), para o export como
   * webclient: a pasta precisa dos ancestrais para herdar variáveis e
   * autenticação (spec 0113). */
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
      if ((data.environments ?? []).length > 0) onImportEnvironments(data.environments)
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
    async (id: string, includeDocumentation: boolean): Promise<ImportOutcome> => {
      const result = await commitPreparedImport(id, workspaceRootPath, includeDocumentation)
      if (!result.ok) return { ok: false, message: result.error.message }
      applyImportedCollections(result.value, false)
      return { ok: true, scripts: importScriptStats(result.value) }
    },
    [applyImportedCollections, workspaceRootPath],
  )

  return {
    collections,
    loaded,
    loadError,
    reload,
    expandedIds,
    toggleExpanded,
    collapseAll,
    expandAll,
    revealRequest,
    addCollection,
    addFolder,
    addRequest,
    duplicateRequest,
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
