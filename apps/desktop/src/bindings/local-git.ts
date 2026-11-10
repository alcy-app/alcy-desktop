import { invokeResult, type CommandResult } from './invoke-result'
import type { WorkspaceDto } from './create-workspace'
import type { VersionControlCommandError, StructuredFileChangesDto } from './version-control-types'

/** Git in the workspace folder, with an `origin` remote (ADR 0074). */
type GitResult<T> = Promise<CommandResult<T, VersionControlCommandError>>

export interface GitMergeDto {
  /** Branch or remote branch being merged. */
  label: string
  conflicts: string[]
}

export interface GitStateDto {
  branch: string
  branches: string[]
  hasCommits: boolean
  /** A merge waiting for its conflicts to be resolved. */
  merge: GitMergeDto | null
  /** URL of `origin`. */
  remote: string | null
  /** Against `origin/<branch>` as of the last fetch; `null` while that branch does not exist there. */
  tracking: { ahead: number; behind: number } | null
}

export function getGitState(rootPath: string): GitResult<GitStateDto> {
  return invokeResult('get_git_state', { input: { rootPath } })
}

/** Files a git operation rewrote on disk. */
export interface GitFilesDto {
  files: string[]
}

export function createGitBranch(rootPath: string, name: string, switchTo: boolean): GitResult<GitFilesDto> {
  return invokeResult('create_git_branch', { input: { rootPath, name, switchTo } })
}

export function switchGitBranch(rootPath: string, name: string): GitResult<GitFilesDto> {
  return invokeResult('switch_git_branch', { input: { rootPath, name } })
}

export function deleteGitBranch(rootPath: string, name: string): GitResult<null> {
  return invokeResult('delete_git_branch', { input: { rootPath, name } })
}

export interface GitMergeResultDto {
  outcome: 'upToDate' | 'fastForward' | 'merged' | 'conflicts'
  conflicts: string[]
  files: string[]
}

export function mergeGitBranch(rootPath: string, name: string): GitResult<GitMergeResultDto> {
  return invokeResult('merge_git_branch', { input: { rootPath, name } })
}

export function finishGitMerge(rootPath: string, message: string): GitResult<{ commitId: string }> {
  return invokeResult('finish_git_merge', { input: { rootPath, message } })
}

export function abortGitMerge(rootPath: string): GitResult<GitFilesDto> {
  return invokeResult('abort_git_merge', { input: { rootPath } })
}

export interface GitCommitDto {
  id: string
  authorName: string
  authorEmail: string
  /** Seconds since the Unix epoch. */
  time: number
  summary: string
  /** Workspace files changed by the commit. */
  files: string[]
  /** First parent first; more than one is a merge. */
  parents: string[]
  /** Local and `origin/…` branches pointing at this commit. */
  refs: string[]
}

export interface GitHistoryDto {
  commits: GitCommitDto[]
  nextOffset: number | null
}

/** One page of the current branch's history and its upstream, newest first. */
export function getGitHistory(rootPath: string, operationId: string, offset: number): GitResult<GitHistoryDto> {
  return invokeResult('get_git_history', { input: { rootPath, operationId, offset } })
}

/** What a commit changed in one file, per item (local = the commit, remote = its parent). */
export function getGitCommitChanges(rootPath: string, commit: string, fileName: string): GitResult<StructuredFileChangesDto> {
  return invokeResult('get_git_commit_changes', { input: { rootPath, commit, fileName } })
}

/** Puts a file back as a commit left it, as an uncommitted change. */
export function restoreGitFile(rootPath: string, commit: string, fileName: string): GitResult<GitFilesDto> {
  return invokeResult('restore_git_file', { input: { rootPath, commit, fileName } })
}

/** Adds, changes or (with `null`) removes `origin`. */
export function setGitRemote(rootPath: string, url: string | null): GitResult<{ url: string | null }> {
  return invokeResult('set_git_remote', { input: { rootPath, url } })
}

/** Downloads what `origin` has, without touching the workspace files. */
export function fetchGitRemote(rootPath: string, operationId: string): GitResult<null> {
  return invokeResult('fetch_git_remote', { input: { rootPath, operationId } })
}

/** Fetches and merges `origin/<branch>` into the current branch. */
export function pullGitRemote(rootPath: string, operationId: string): GitResult<GitMergeResultDto> {
  return invokeResult('pull_git_remote', { input: { rootPath, operationId } })
}

export function pushGitRemote(rootPath: string, operationId: string): GitResult<null> {
  return invokeResult('push_git_remote', { input: { rootPath, operationId } })
}

export interface CloneGitWorkspaceInput {
  operationId: string
  url: string
  /** `url` is a workspace folder, to be set up as the remote of the new copy. */
  fromFolder?: boolean
}

/** Clones a repository holding an Alcy workspace into the workspaces folder and opens it. */
export function cloneGitWorkspace(input: CloneGitWorkspaceInput): GitResult<WorkspaceDto> {
  return invokeResult('clone_git_workspace', { input })
}

export interface WorkspaceFolderInspectionDto {
  /** The folder holds a committed workspace and has no remote of its own. */
  canCloneAsRemote: boolean
}

/** How a folder chosen for import can be brought in. */
export function inspectWorkspaceFolder(rootPath: string): GitResult<WorkspaceFolderInspectionDto> {
  return invokeResult('inspect_workspace_folder', { input: { rootPath } })
}

/** Trusts a folder git refused over its ownership. Only after the person confirms it. */
export function trustGitFolder(path: string): GitResult<null> {
  return invokeResult('trust_git_folder', { input: { path } })
}

export interface GitIdentityFieldsDto {
  name: string | null
  email: string | null
}

export interface GitIdentityDto {
  /** `user.name`/`user.email` from the system's git config. */
  system: GitIdentityFieldsDto
  /** Values set in Alcy; `null` uses the system's. */
  overrides: GitIdentityFieldsDto
  /** Author of the next commit, or `null` while name or e-mail is unknown. */
  effective: GitIdentityFieldsDto | null
}

export function getGitIdentity(): GitResult<GitIdentityDto> {
  return invokeResult('get_git_identity')
}

export function saveGitIdentity(input: GitIdentityFieldsDto): GitResult<GitIdentityDto> {
  return invokeResult('save_git_identity', { input })
}
