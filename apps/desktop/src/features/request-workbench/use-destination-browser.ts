import { useMemo, useState } from 'react'
import type { TreeNode } from './collection-tree'

interface DestinationBrowserOptions {
  collections: TreeNode[]
  /** Pastas que não aparecem como destino (ex.: as pastas sendo movidas e suas subpastas). */
  excludedIds?: ReadonlySet<string>
  /** Cria uma collection com o nome dado e devolve o id dela. */
  onCreateCollection: (name: string) => string
  /** Cria uma pasta com o nome dado dentro de `parentId` e devolve o id dela. */
  onCreateFolder: (parentId: string, name: string) => string
}

/** Resolve a pilha de ids navegados contra a árvore atual; ids que não existem
 * mais (ou uma collection recém-criada que ainda não chegou na árvore) cortam
 * o caminho naquele ponto. */
function resolvePath(collections: TreeNode[], ids: string[]): TreeNode[] {
  const nodes: TreeNode[] = []
  let level = collections
  for (const id of ids) {
    const node = level.find((candidate) => candidate.id === id)
    if (!node) break
    nodes.push(node)
    level = node.folders
  }
  return nodes
}

/** Estado da escolha de destino navegando em níveis (collection → subpastas),
 * compartilhado pelos modais de salvar e mover. O destino é o nível em que o
 * usuário está; na raiz ainda não há destino (`currentNode` é `null`). */
export function useDestinationBrowser({
  collections,
  excludedIds,
  onCreateCollection,
  onCreateFolder,
}: DestinationBrowserOptions) {
  const [pathIds, setPathIds] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [creatingNode, setCreatingNode] = useState(false)
  const [newNodeName, setNewNodeName] = useState('')

  const path = useMemo(() => resolvePath(collections, pathIds), [collections, pathIds])
  const currentNode = path.at(-1) ?? null

  const needle = query.trim().toLowerCase()
  const levelFolders = (currentNode ? currentNode.folders : collections).filter(
    (folder) => !excludedIds?.has(folder.id) && (!needle || folder.name.toLowerCase().includes(needle)),
  )
  const levelRequests = currentNode && !needle ? currentNode.requests : []

  const cancelNewNode = () => {
    setCreatingNode(false)
    setNewNodeName('')
  }

  const startNewNode = () => {
    setQuery('')
    setCreatingNode(true)
  }

  const enter = (id: string) => {
    setPathIds([...path.map((node) => node.id), id])
    setQuery('')
    cancelNewNode()
  }

  const goBack = () => {
    setPathIds(path.slice(0, -1).map((node) => node.id))
    setQuery('')
    cancelNewNode()
  }

  const createNode = () => {
    const trimmed = newNodeName.trim()
    if (!trimmed) return
    if (currentNode) {
      enter(onCreateFolder(currentNode.id, trimmed))
    } else {
      setPathIds([onCreateCollection(trimmed)])
      setQuery('')
      cancelNewNode()
    }
  }

  return {
    path,
    currentNode,
    query,
    setQuery,
    searching: needle.length > 0,
    levelFolders,
    levelRequests,
    creatingNode,
    newNodeName,
    setNewNodeName,
    startNewNode,
    cancelNewNode,
    createNode,
    enter,
    goBack,
  }
}

export type DestinationBrowserState = ReturnType<typeof useDestinationBrowser>
