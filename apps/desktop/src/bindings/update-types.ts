export type UpdateProvider = 'github' | 'manifest' | 'releaseServer'

/** Origem das releases definida no build (`ALCY_UPDATE_PROVIDER`/`ALCY_UPDATE_URL`). */
export interface UpdateSourceDto {
  provider: UpdateProvider
  /** O que exibir: URL do projeto, `dono/repositorio`, URL do manifesto ou do servidor de releases. */
  location: string
  host: string
}

export interface UpdateSettingsDto {
  currentVersion: string
  checkOnStartup: boolean
  /** Preview (pre-release) versions are offered too. */
  includePrereleases: boolean
  /** `null` = o build não tem origem de atualizações. */
  source: UpdateSourceDto | null
}

export interface ReleaseDto {
  version: string
  name: string | null
  /** Descrição da release (markdown, exibida como texto). */
  notes: string | null
  publishedAt: string | null
  webUrl: string | null
  /** A instalação atual consegue se atualizar sozinha (no Linux, só o AppImage). */
  installable: boolean
}

export interface UpdateCheckDto {
  currentVersion: string
  /** `null` = a versão instalada é a mais recente. */
  release: ReleaseDto | null
}

export interface DownloadProgressDto {
  downloaded: number
  total: number | null
}

export type UpdateCommandError =
  | { kind: 'notConfigured' }
  | { kind: 'invalid'; message: string }
  | { kind: 'notFound'; message: string }
  | { kind: 'noReleases' }
  | { kind: 'noManifest'; tag: string }
  | { kind: 'missingPublicKey' }
  | { kind: 'signature'; message: string }
  | { kind: 'network'; message: string }
  | { kind: 'rejected'; message: string }
  | { kind: 'storage'; message: string }
  | { kind: 'notAvailable' }
  | { kind: 'noPendingUpdate' }
  /** O backup dos workspaces falhou; a atualização não foi instalada. */
  | { kind: 'backup'; message: string }
  | { kind: 'updater'; message: string }
  | { kind: 'cancelled' }
