import { getCurrentWindow } from '@tauri-apps/api/window'

export type UnlistenFn = () => void

/** Registra um handler para o pedido de fechamento da janela do app (clique
 * no X, Alt+F4, etc.). Diferente de um listener comum: registrá-lo muda o
 * comportamento nativo da janela para fechamento manual — se o handler não
 * chamar `event.preventDefault()`, a janela só fecha depois que a Promise
 * retornada (se houver) resolver. É o lugar certo para aguardar um flush de
 * dados pendentes antes do app sumir.
 *
 * Fora de um contexto Tauri (ex.: testes rodando em jsdom) `getCurrentWindow`
 * lança de forma síncrona — captura e devolve um unlisten inofensivo em vez
 * de derrubar a árvore React, mesma resiliência que os demais bindings têm
 * ao redor de `invoke`. */
export async function onWindowCloseRequested(handler: () => void | Promise<void>): Promise<UnlistenFn> {
  try {
    return await getCurrentWindow().onCloseRequested(async () => {
      await handler()
    })
  } catch {
    return () => {}
  }
}
