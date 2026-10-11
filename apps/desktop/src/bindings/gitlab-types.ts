/** Erro comum aos commands de GitLab e de controle de versão (nunca carrega tokens). */
export type GitlabCommandError =
  | { kind: 'invalid'; message: string }
  | { kind: 'storage'; message: string }
  | { kind: 'credentials'; message: string }
  | { kind: 'unauthorized' }
  | { kind: 'network'; message: string }
  | { kind: 'rejected'; message: string }
  | { kind: 'notFound'; message: string }
  | { kind: 'conflict' }
  | { kind: 'tooLarge' }
  | { kind: 'files'; message: string }
  | { kind: 'conflicts'; files: string[] }
  | { kind: 'nothingToCommit' }
  | { kind: 'emptyMessage' }
  | { kind: 'notLinked' }
  | { kind: 'accountMissing' }
  | { kind: 'branchNotWritable' }
  | { kind: 'denied'; message: string }
  | { kind: 'login'; message: string }
  | { kind: 'timeout' }
  | { kind: 'portBusy'; port: number }
  | { kind: 'browser'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'incompleteResolution'; file: string }

export interface GitlabAccountDto {
  id: string
  baseUrl: string
  clientId: string
  username: string
  name: string
}

export interface GitlabProjectDto {
  id: number
  pathWithNamespace: string
  defaultBranch: string | null
}

export interface GitlabBranchDto {
  name: string
  isDefault: boolean
  canPush: boolean
}

export interface PageDto<T> {
  items: T[]
  nextPage: number | null
}

export interface WorkspaceLinkDto {
  accountId: string
  projectId: number
  projectPath: string
  branch: string
  directory: string
  includeEnvironments: boolean
}

export type FileState = 'clean' | 'localAdded' | 'localModified' | 'localDeleted' | 'remoteChanged' | 'conflict'

export interface FileStatusDto {
  name: string
  state: FileState
  /** Hash do conteúdo local que originou este estado. */
  localRevision?: string | null
  /** Hash remoto observado, ou a última base conhecida no status local. */
  remoteRevision?: string | null
}

export interface VersionStatusDto {
  link: WorkspaceLinkDto
  files: FileStatusDto[]
}

export type DiffLineKind = 'context' | 'added' | 'removed'

export interface DiffLineDto {
  kind: DiffLineKind
  text: string
}

export interface DiffHunkDto {
  remoteStart: number
  localStart: number
  lines: DiffLineDto[]
}

export interface FileDiffDto {
  name: string
  remoteExists: boolean
  localExists: boolean
  hunks: DiffHunkDto[]
  tooLarge: boolean
  binary: boolean
  truncated: boolean
}

export type ItemChangeKind = 'added' | 'modified' | 'deleted'

export interface FieldChangeDto {
  name: string
  remote: string | null
  local: string | null
}

export interface ChangedItemDto {
  id: string
  parentId: string | null
  label: string
  itemKind: 'collection' | 'folder' | 'request' | 'flow' | 'environment' | 'monitor'
  changeKind: ItemChangeKind
  fields: FieldChangeDto[]
  dependencies: string[]
}

export interface StructuredFileChangesDto {
  name: string
  localRevision: string | null
  remoteRevision: string | null
  supportsPartial: boolean
  /** Total de itens alterados no snapshot, antes da paginação IPC. */
  totalItems?: number
  /** Próxima página do backend; o binding público reúne todas as páginas. */
  nextOffset?: number | null
  items: ChangedItemDto[]
}

export interface ChangeSelectionDto {
  name: string
  wholeFile: boolean
  itemIds: string[]
  expectedLocalRevision: string | null
  expectedRemoteRevision: string | null
}

export interface PullPreviewDto {
  /** Arquivos alterados só no remoto; uma atualização os aplicaria. */
  incoming: string[]
  /** Arquivos em conflito; uma atualização não os toca. */
  conflicts: string[]
}

export type ConflictSide = 'local' | 'remote'

export interface ItemResolutionDto {
  itemId: string
  side: ConflictSide
}

/** Entrada de `resolveConflict`: por inteiro ou item a item (só para arquivos com estrutura reconhecida). */
export type ResolutionInput =
  | { kind: 'keepLocal' }
  | { kind: 'keepRemote' }
  | { kind: 'perItem'; items: ItemResolutionDto[]; expectedLocalRevision: string | null; expectedRemoteRevision: string | null }

export interface ResolutionPreviewFieldDto {
  name: string
  value: string
}

export interface ResolutionPreviewDto {
  itemId: string
  label: string
  itemKind: ChangedItemDto['itemKind']
  exists: boolean
  fields: ResolutionPreviewFieldDto[]
}
