/** Modais abertos, do mais antigo ao mais recente. Com um modal aberto sobre
 * outro, só o do topo responde ao Escape e prende o Tab. */
export const openModals: symbol[] = []

/** Há algum modal aberto — usado por interações globais (ex.: soltar uma
 * imagem na janela para importar) que não devem agir por trás de um modal. */
export function hasOpenModal(): boolean {
  return openModals.length > 0
}
