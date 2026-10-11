type BeforeExitHandler = () => void | Promise<void>

const handlers = new Set<BeforeExitHandler>()

/** Registra trabalho que precisa terminar antes de o app encerrar por conta
 * própria (ex.: reiniciar para instalar uma atualização), caminho que não
 * passa pelo pedido de fechamento da janela. Devolve a função que remove o
 * registro. */
export function registerBeforeExit(handler: BeforeExitHandler): () => void {
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
  }
}

/** Executa todos os handlers registrados; a falha de um não impede os outros. */
export async function runBeforeExit(): Promise<void> {
  await Promise.allSettled([...handlers].map(async (handler) => handler()))
}
