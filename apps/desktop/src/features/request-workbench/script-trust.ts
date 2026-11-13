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

/** npm packages the scripts require with a literal `require('npm:…')`, without the prefix or
 * repetitions, in order of appearance: the ones trusting the scripts lets the app download from
 * esm.sh when they run (spec 0128). Mirrors `npm_requests` in `alcy-scripting`. */
export function npmPackages(scripts: string[]): string[] {
  const found: string[] = []
  for (const source of scripts) {
    for (let at = source.indexOf('require('); at !== -1; at = source.indexOf('require(', at + 1)) {
      const rest = source.slice(at + 'require('.length).trimStart()
      const quote = rest[0]
      if (quote !== "'" && quote !== '"' && quote !== '`') continue
      const end = rest.indexOf(quote, 1)
      if (end === -1) continue
      const literal = rest.slice(1, end)
      if (!literal.startsWith('npm:')) continue
      const name = literal.slice('npm:'.length).trim()
      if (name !== '' && !name.includes('$') && !found.includes(name)) found.push(name)
    }
  }
  return found
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
