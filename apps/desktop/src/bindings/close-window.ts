import { getCurrentWindow } from '@tauri-apps/api/window'

/** Fecha a janela do app. Fora de um contexto Tauri (ex.: testes em jsdom) é um no-op
 * silencioso. */
export async function closeWindow(): Promise<void> {
  try {
    await getCurrentWindow().close()
  } catch {
    // no-op fora de um contexto Tauri
  }
}
