import { getCurrentWindow } from '@tauri-apps/api/window'

/** Consulta se a janela está maximizada agora. Fora de um contexto Tauri (ex.: testes
 * em jsdom) devolve `false`, mesma resiliência dos demais bindings. */
export async function isWindowMaximized(): Promise<boolean> {
  try {
    return await getCurrentWindow().isMaximized()
  } catch {
    return false
  }
}
