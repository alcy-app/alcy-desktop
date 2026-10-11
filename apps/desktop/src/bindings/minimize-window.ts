import { getCurrentWindow } from '@tauri-apps/api/window'

/** Minimiza a janela do app. Fora de um contexto Tauri (ex.: testes em jsdom) é um
 * no-op silencioso, mesma resiliência dos demais bindings ao redor de `getCurrentWindow`. */
export async function minimizeWindow(): Promise<void> {
  try {
    await getCurrentWindow().minimize()
  } catch {
    // no-op fora de um contexto Tauri
  }
}
