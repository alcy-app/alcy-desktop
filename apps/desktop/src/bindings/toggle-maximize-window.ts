import { getCurrentWindow } from '@tauri-apps/api/window'

/** Alterna a janela entre maximizada e seu tamanho restaurado. Fora de um contexto
 * Tauri (ex.: testes em jsdom) é um no-op silencioso. */
export async function toggleMaximizeWindow(): Promise<void> {
  try {
    await getCurrentWindow().toggleMaximize()
  } catch {
    // no-op fora de um contexto Tauri
  }
}
