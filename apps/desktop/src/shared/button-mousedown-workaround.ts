/**
 * Contorna um bug do WebKitGTK (webview do Tauri no Linux): mesmo com
 * `user-select: none` no CSS, um mousedown sobre um botão às vezes inicia
 * uma seleção de texto em vez de permitir o clique — intermitente,
 * reproduzível em qualquer botão do app. `preventDefault` no mousedown
 * evita a seleção sem cancelar o `click` seguinte; o foco é restaurado
 * manualmente porque o mesmo `preventDefault` também suprime o foco padrão
 * do navegador ao clicar.
 *
 * Efeito colateral: o `focus()` roda antes de qualquer handler do React, então
 * um botão dentro de um popup que fecha no `blur` do campo de origem (ex.:
 * lista de sugestões) some antes de receber o próprio `mousedown`. Esses itens
 * não devem ser `<button>` — ver `TemplateHighlightedField`.
 *
 * Devolve a função que remove o listener (usada nos testes).
 */
export function installButtonMousedownWorkaround(target: Document = document): () => void {
  const onMouseDown = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return
    const control = event.target.closest<HTMLElement>('button, [role="tab"]')
    if (!control) return
    event.preventDefault()
    control.focus()
  }
  target.addEventListener('mousedown', onMouseDown, { capture: true })
  return () => target.removeEventListener('mousedown', onMouseDown, { capture: true })
}
