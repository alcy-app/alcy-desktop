import { open } from '@tauri-apps/plugin-dialog'

/** Abre o diálogo nativo para escolher o arquivo de um corpo REST (binary ou
 * campo de arquivo do form-data). Só o caminho volta — o backend lê os bytes
 * na hora de enviar (ADR 0024). */
export async function pickBodyFile(): Promise<string | null> {
  const selected = await open({ directory: false, multiple: false })
  return typeof selected === 'string' ? selected : null
}
