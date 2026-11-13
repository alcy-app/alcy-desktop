import type { ScriptsSkipReason, WorkspaceScriptTrust } from '../../bindings/script-trust'
import type { RequestSummary, TreeNode } from './collection-tree'

/** Whether a request would run a script: whitespace-only scripts are skipped, as in the backend. */
export function requestHasScripts(request: RequestSummary): boolean {
  return request.content.preRequestScript.trim() !== '' || request.content.postResponseScript.trim() !== ''
}

/** Whether a collection or folder has a request with a script, at any depth. */
export function nodeHasScripts(node: TreeNode): boolean {
  return node.requests.some(requestHasScripts) || node.folders.some(nodeHasScripts)
}

/** All requests with a script under a collection, with their folder path, for the review before trusting it. */
export function scriptedRequests(node: TreeNode, path: string[] = []): { path: string[]; request: RequestSummary }[] {
  return [
    ...node.requests.filter(requestHasScripts).map((request) => ({ path, request })),
    ...node.folders.flatMap((folder) => scriptedRequests(folder, [...path, folder.name])),
  ]
}

/** The collection (root node) holding the request, or `null` for an unsaved tab or an unknown id. */
export function collectionOfRequest(collections: TreeNode[], requestId: string | null): TreeNode | null {
  if (requestId === null) return null
  const holds = (node: TreeNode): boolean =>
    node.requests.some((request) => request.id === requestId) || node.folders.some(holds)
  return collections.find(holds) ?? null
}

/** Why the scripts of a collection do not run, mirroring the backend (spec 0162). A trust still
 * loading counts as not trusted, like the backend's undecided. */
export function collectionScriptsLock(
  workspace: WorkspaceScriptTrust | null,
  collection: TreeNode | null,
): ScriptsSkipReason | null {
  if (collection === null) return null
  if (workspace !== 'trusted') return 'workspace'
  return collection.untrustedScripts ? 'collection' : null
}
