/** Conta Microsoft conectada; o token fica no chaveiro do sistema, em Rust. */
export interface OnedriveAccountDto {
  id: string
  tenant: string
  clientId: string
  username: string
  name: string
}

/** Pasta do OneDrive/SharePoint; os ids endereçam, o caminho só é exibido. */
export interface DriveFolderDto {
  driveId: string
  id: string
  name: string
  path: string
  childCount: number | null
}

export interface FolderPageDto {
  items: DriveFolderDto[]
  /** Link opaco da próxima página do Microsoft Graph. */
  nextLink: string | null
}
