import { open } from '@tauri-apps/plugin-dialog'

/** Retorna o caminho escolhido, ou `null` se o usuário cancelar o diálogo. */
export async function pickWorkspaceFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false })
  return typeof selected === 'string' ? selected : null
}
