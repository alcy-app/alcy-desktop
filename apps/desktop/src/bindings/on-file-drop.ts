import { getCurrentWebview } from '@tauri-apps/api/webview'

export type FileDropEvent =
  | { type: 'enter'; paths: string[] }
  | { type: 'over' }
  | { type: 'drop'; paths: string[] }
  | { type: 'leave' }

export type UnlistenFn = () => void

/** Janela em que um drop com os mesmos arquivos é tratado como cópia do anterior. */
const DUPLICATE_DROP_MS = 1000

/** Registra um handler para arquivos arrastados sobre a janela (arraste do
 * SO, não o drag-and-drop interno de reordenar a árvore de coleções). Evento
 * nativo do webview do Tauri — sem filtro por elemento DOM, então quem
 * registra decide sozinho quando o listener deve estar ativo (ex.: só
 * enquanto uma aba/modal específica está visível).
 *
 * Fora de um contexto Tauri (ex.: testes rodando em jsdom) `getCurrentWebview`
 * lança de forma síncrona — captura e devolve um unlisten inofensivo, mesma
 * resiliência que os demais bindings têm ao redor de `invoke`. */
export async function onFileDrop(handler: (event: FileDropEvent) => void): Promise<UnlistenFn> {
  // Numa janela com webview, o Tauri emite o mesmo "soltar" para a janela e
  // para o webview, e o listener do webview recebe os dois (o GTK ainda pode
  // repetir o evento). Sem descartar as cópias, cada arquivo seria importado
  // mais de uma vez.
  let lastDrop: { key: string; at: number } | null = null
  try {
    return await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload
      if (payload.type === 'drop') {
        const key = payload.paths.join('\0')
        const now = Date.now()
        if (lastDrop && lastDrop.key === key && now - lastDrop.at < DUPLICATE_DROP_MS) return
        lastDrop = { key, at: now }
      }
      handler(payload)
    })
  } catch {
    return () => {}
  }
}
