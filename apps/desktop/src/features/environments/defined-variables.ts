/** Variáveis com nome preenchido. Uma linha recém-adicionada e ainda sem nome é rascunho: não define nada, não é
 * gravada em disco e não pode barrar a execução (o backend rejeita nome vazio). Devolve o mesmo array quando não há
 * o que remover. */
export function definedVariables<T extends { name: string }>(variables: T[]): T[] {
  const isBlank = (variable: T) => variable.name.trim() === ''
  return variables.some(isBlank) ? variables.filter((variable) => !isBlank(variable)) : variables
}
