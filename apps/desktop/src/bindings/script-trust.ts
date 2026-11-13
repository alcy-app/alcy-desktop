import { invokeResult, type CommandResult } from './invoke-result'

/** This person's decision about the scripts of a workspace folder (spec 0162). */
export type WorkspaceScriptTrust = 'trusted' | 'untrusted' | 'undecided'

export type ScriptTrustError = { kind: 'notFound'; message: string } | { kind: 'storage'; message: string }

/** Scripts of a send that did not run because they are not trusted; the request went out without them. */
export interface ScriptsSkippedDto {
  reason: ScriptsSkipReason
  preRequest: boolean
  postResponse: boolean
}

export type ScriptsSkipReason = 'workspace' | 'collection'

export function getWorkspaceScriptTrust(rootPath: string): Promise<CommandResult<WorkspaceScriptTrust, ScriptTrustError>> {
  return invokeResult('get_workspace_script_trust', { input: { rootPath } })
}

export function setWorkspaceScriptTrust(rootPath: string, trusted: boolean): Promise<CommandResult<null, ScriptTrustError>> {
  return invokeResult('set_workspace_script_trust', { input: { rootPath, trusted } })
}

/** Marks or clears one collection; the mark lives in the collection file and reaches everyone who receives it. */
export function setCollectionScriptTrust(
  rootPath: string,
  collectionId: string,
  trusted: boolean,
): Promise<CommandResult<null, ScriptTrustError>> {
  return invokeResult('set_collection_script_trust', { input: { rootPath, collectionId, trusted } })
}
