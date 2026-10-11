import type { EnvironmentVariableDto } from '../../bindings/list-environments'

function resolveTemplate(template: string, variables: EnvironmentVariableDto[], includeSensitive: boolean): string {
  return template.replace(/\{\{([^{}]*)\}\}/g, (placeholder, rawName: string) => {
    const name = rawName.trim()
    const variable = variables.find((candidate) => candidate.name === name)
    return variable && (includeSensitive || !variable.sensitive) ? variable.value : placeholder
  })
}

/** Substitui `{{nome}}` pelos valores do ambiente ativo, para exibir, gravar
 * ou compartilhar como código o texto real (URL, headers, corpo). Variáveis
 * sensíveis e ausentes ficam como placeholder (nunca expõe segredos). A
 * resolução que vale para o envio é a do Rust; esta é só para exibição. */
export function resolveTemplateForDisplay(template: string, variables: EnvironmentVariableDto[]): string {
  return resolveTemplate(template, variables, false)
}

/** Como `resolveTemplateForDisplay`, mas resolve também as variáveis
 * sensíveis. Só para dados que ficam em memória e passam pela ocultação do
 * gravador HAR (`har-redaction.ts`) antes de aparecer ou ser exportados. */
export function resolveTemplateRevealingSecrets(template: string, variables: EnvironmentVariableDto[]): string {
  return resolveTemplate(template, variables, true)
}
