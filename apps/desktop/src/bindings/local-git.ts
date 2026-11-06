import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabCommandError, StructuredFileChangesDto, WorkspaceLinkDto } from './gitlab-types'

/** Git in the workspace folder, shared through a folder (ADR 0074). */
type GitResult<T> = Promise<CommandResult<T, GitlabCommandError>>

export interface GitMergeDto {
  /** Person or branch being merged. */
  label: string
  conflicts: string[]
}

export interface GitStateDto {
  branch: string
  branches: string[]
  hasCommits: boolean
  /** A merge waiting for its conflicts to be resolved. */
  merge: GitMergeDto | null
  sharedFolder: string | null
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
  merge: boolean
}

export interface GitHistoryDto {
  commits: GitCommitDto[]
  nextOffset: number | null
}

/** One page of the current branch's history, newest first. */
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

/** `null` stops sharing; an empty folder gets a repository created. */
export function setGitSharedFolder(rootPath: string, folder: string | null): GitResult<WorkspaceLinkDto> {
  return invokeResult('set_git_shared_folder', { input: { rootPath, folder } })
}

export interface GitPeerDto {
  peer: string
  /** Author of their latest commit (or their id while it is still syncing). */
  name: string
  time: number
  state: 'upToDate' | 'incoming' | 'syncing'
}

export function getGitPeers(rootPath: string, operationId: string): GitResult<GitPeerDto[]> {
  return invokeResult('get_git_peers', { input: { rootPath, operationId } })
}

export interface GitSyncDto {
  published: boolean
  /** People whose work was brought in. */
  integrated: string[]
  /** People whose latest work the sync client is still delivering. */
  syncing: string[]
  merge: GitMergeDto | null
  files: string[]
}

/** Publishes this person's branch and brings in everyone else's. */
export function syncGitSharedFolder(rootPath: string, operationId: string): GitResult<GitSyncDto> {
  return invokeResult('sync_git_shared_folder', { input: { rootPath, operationId } })
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
