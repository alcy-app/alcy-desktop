import { getCurrentWindow } from '@tauri-apps/api/window'

export type UnlistenFn = () => void

/** Registra um handler chamado sempre que a janela é redimensionada (inclui alternar
 * maximizado/restaurado por atalho do SO ou arrastando a borda, não só pelo botão do
 * app). Fora de um contexto Tauri (ex.: testes em jsdom) devolve um unlisten inofensivo,
 * mesma resiliência dos demais bindings ao redor de `getCurrentWindow`. */
export async function onWindowResized(handler: () => void | Promise<void>): Promise<UnlistenFn> {
  try {
    return await getCurrentWindow().onResized(async () => {
      await handler()
    })
  } catch {
    return () => {}
  }
}
