import { parse, print } from 'graphql'

/**
 * Reformata uma query GraphQL com indentação e espaçamento padrão — o
 * "Organizar" do editor. Devolve `null` quando a query não é sintaticamente
 * válida, para o chamador decidir o que fazer (ex.: manter o botão
 * desabilitado) em vez de arriscar substituir o texto do usuário por um erro.
 */
export function formatGraphqlQuery(source: string): string | null {
  try {
    return print(parse(source))
  } catch {
    return null
  }
}
