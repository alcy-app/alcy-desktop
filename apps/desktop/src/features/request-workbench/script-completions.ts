import { autocompletion, snippetCompletion } from '@codemirror/autocomplete'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import type { Extension } from '@codemirror/state'
import { completionTheme, floatingTooltips } from './codemirror-shared'
import { automaticSuggestionsEnabled } from './completion-shortcuts'
import {
  MODULE_NAME_COMPLETIONS,
  destructuredModule,
  memberChainBefore,
  moduleChainMembers,
  moduleMembers,
  requiredModules,
} from './script-modules'

export type ScriptPhase = 'pre' | 'post'

type Member = Completion

const fn = (label: string, template: string, detail: string, info: string): Member =>
  snippetCompletion(template, { label, detail, info, type: 'function' })

const prop = (label: string, detail: string, info: string): Member => ({ label, detail, info, type: 'property' })

/** require is also available as al.require (spec 0128). Picking it reopens
 * the list inside the quotes with the available modules. */
const requireCompletion = fn(
  'require',
  "require('${}')",
  '(name) → module',
  'Carrega uma biblioteca: lodash, crypto-js, moment e uuid já vêm com o app; ' +
    "'npm:<pacote>@<versão>' baixa um pacote do npm na primeira execução e o guarda para uso offline.",
)

/** Members of al by dotted path. al.response exists only after a response (spec 0054). */
function membersOf(path: string, phase: ScriptPhase): Member[] {
  switch (path) {
    case 'al':
      return [
        prop('request', 'requisição', 'URL, método, corpo e headers da requisição.'),
        ...(phase === 'post' ? [prop('response', 'resposta', 'Resposta recebida (somente leitura).')] : []),
        prop('environment', 'ambiente', 'Variáveis do ambiente ativo (escopo global).'),
        prop('collection', 'coleção', 'Variáveis da coleção da requisição (escopo local).'),
        prop('folder', 'pasta', 'Variáveis da pasta que contém a requisição (escopo local).'),
        prop('variables', 'local', 'Variáveis locais da requisição, preservadas do pré ao pós.'),
        prop('runtime', 'runtime', 'Variáveis compartilhadas durante o runner ou flow.'),
        prop('info', 'metadados', 'Fase e iteração da execução atual.'),
        prop('console', 'console', 'Registra mensagens exibidas na aba Scripts.'),
        fn(
          'test',
          "test('${name}', function () {\n  al.expect(${value}).toBe(${expected})\n})",
          '(name, fn)',
          'Registra um teste: passa quando a função não lança erro. Os resultados aparecem na aba Tests e no runner.',
        ),
        fn(
          'expect',
          'expect(${value}).toBe(${expected})',
          '(value) → matchers',
          'Asserção: toBe, toEqual, toBeTruthy, toBeFalsy, toBeDefined, toBeNull, toContain, toMatch, ' +
            'toBeGreaterThan, toBeLessThan, toHaveLength, toHaveProperty; .not inverte.',
        ),
        prop('iteration', 'iteração', 'Iteração atual do runner de coleções (index, count). Fora do runner: 0 de 1.'),
        prop('iterationData', 'dados', 'Valores da linha do arquivo de dados na iteração atual do runner.'),
        requireCompletion,
      ]
    case 'al.request':
      return [
        prop('grpc', 'gRPC', 'Serviço, método, mensagem JSON e metadata de uma requisição gRPC.'),
        prop('websocket', 'WebSocket', 'Subprotocolos e mensagem de uma requisição WebSocket.'),
        prop('url', 'string', 'URL da requisição (com {{variáveis}} ainda não resolvidas).'),
        prop('method', 'string', 'Método HTTP em minúsculas (get, post, ...).'),
        prop('body', 'string', 'Corpo da requisição (a query, em GraphQL).'),
        prop('headers', 'headers', 'Lê e altera os headers da requisição.'),
        fn('getUrl', 'getUrl()', '() → string', 'Lê a URL.'), fn('setUrl', 'setUrl(${url})', '(url)', 'Altera a URL.'),
        fn('getMethod', 'getMethod()', '() → string', 'Lê o método.'), fn('setMethod', 'setMethod(${method})', '(method)', 'Altera o método.'),
        fn('getBody', 'getBody()', '() → string', 'Lê o corpo.'), fn('setBody', 'setBody(${body})', '(body)', 'Altera o corpo.'),
        fn('json', 'json()', '() → any', 'Interpreta o corpo JSON.'), fn('setJson', 'setJson(${value})', '(value)', 'Serializa o corpo JSON.'),
      ]
    case 'al.request.grpc':
      return [prop('service', 'string', 'Serviço gRPC completo.'), prop('method', 'string', 'Método gRPC.'),
        prop('message', 'JSON', 'Mensagem JSON; atribua um objeto para alterar o envio.'), prop('metadata', 'metadata', 'Lê e altera a metadata enviada.')]
    case 'al.request.websocket':
      return [prop('subprotocols', 'array', 'Subprotocolos oferecidos; atribua uma lista para alterar.'),
        prop('message', 'string', 'Mensagem do composer; atribua texto ou um objeto (vira JSON).')]
    case 'al.request.grpc.metadata':
    case 'al.request.headers':
      return [
        fn('get', "get('${name}')", '(name) → string', 'Valor do header, ou undefined.'),
        fn('set', "set('${name}', '${value}')", '(name, value)', 'Define ou substitui um header (só no pré-requisição).'),
        fn('remove', "remove('${name}')", '(name)', 'Remove um header (só no pré-requisição).'),
        fn('has', "has('${name}')", '(name) → boolean', 'Informa se o header existe.'),
        fn('toObject', 'toObject()', '() → object', 'Retorna todos os headers.'),
        fn('setAll', 'setAll(${headers})', '(object)', 'Define headers em lote.'), fn('removeAll', 'removeAll()', '()', 'Remove todos os headers.'),
      ]
    case 'al.response.grpc':
      return phase === 'post' ? [prop('code', 'number', 'Código gRPC (0 = OK).'), prop('codeName', 'string', 'Nome do status gRPC.'),
        prop('message', 'string', 'Mensagem do status gRPC.'), prop('trailers', 'array', 'Metadata final.'), prop('messages', 'array', 'Mensagens recebidas em JSON.')] : []
    case 'al.response.websocket':
      return phase === 'post' ? [prop('closeCode', 'number', 'Código de fechamento, ou null.'), prop('closeReason', 'string', 'Motivo do fechamento.'),
        prop('closedBy', 'string', 'client, server, transport ou rejected.'), prop('subprotocol', 'string', 'Subprotocolo aceito pelo servidor.'),
        prop('sent', 'number', 'Mensagens enviadas.'), prop('received', 'number', 'Mensagens recebidas.'),
        prop('messages', 'array', 'Mensagens recebidas (JSON quando possível).')] : []
    case 'al.response':
      return phase === 'post'
        ? [
            prop('grpc', 'gRPC', 'Status, metadata final e mensagens recebidas em gRPC.'),
            prop('websocket', 'WebSocket', 'Fechamento e mensagens recebidas em WebSocket.'),
            prop('status', 'number', 'Código de status HTTP.'),
            prop('time', 'number', 'Duração da requisição em ms.'),
            prop('statusText', 'string', 'Texto do status HTTP.'), prop('size', 'number', 'Tamanho da resposta.'),
            prop('url', 'string', 'URL final da resposta.'), prop('body', 'string', 'Corpo bruto da resposta.'),
            prop('headers', 'headers', 'Headers da resposta.'),
            fn('text', 'text()', '() → string', 'Corpo da resposta como texto.'),
            fn('json', 'json()', '() → any', 'Corpo da resposta interpretado como JSON.'),
          ]
        : []
    case 'al.response.headers':
      return phase === 'post' ? [fn('get', "get('${name}')", '(name) → string', 'Valor do header, ou undefined.')] : []
    case 'al.environment':
    case 'al.variables':
    case 'al.runtime':
    case 'al.collection':
    case 'al.folder':
      return [
        fn('get', "get('${name}')", '(name) → value', 'Valor da variável, ou undefined.'),
        fn('set', "set('${name}', ${value})", '(name, value)', 'Grava uma variável no escopo.'),
        fn('has', "has('${name}')", '(name) → boolean', 'Verifica se a variável existe.'),
        fn('unset', "unset('${name}')", '(name)', 'Remove uma variável.'),
        fn('clear', 'clear()', '()', 'Limpa o escopo.'),
        fn('toObject', 'toObject()', '() → object', 'Copia o escopo.'),
        fn('replaceIn', 'replaceIn(${text})', '(text) → string', 'Resolve placeholders no texto.'),
      ]
    case 'al.iteration':
      return [
        prop('index', 'number', 'Índice da iteração atual, a partir de 0.'),
        prop('count', 'number', 'Total de iterações do run.'),
      ]
    case 'al.iterationData':
      return [
        fn('get', "get('${name}')", '(name) → string', 'Valor da coluna na linha da iteração atual, ou undefined.'),
        fn('toObject', 'toObject()', '() → object', 'Todos os valores da linha da iteração atual.'),
      ]
    case 'al.info':
      return [prop('phase', 'string', 'Fase atual.'), prop('iteration', 'number', 'Iteração atual.'), prop('iterationCount', 'number', 'Total de iterações.')]
    case 'al.console':
      return [fn('info', 'info(${message})', '(...args)', 'Registra informação.'), fn('warn', 'warn(${message})', '(...args)', 'Registra aviso.'), fn('error', 'error(${message})', '(...args)', 'Registra erro.'), fn('log', 'log(${message})', '(...args)', 'Registra uma mensagem na saída da aba Scripts.')]
    default:
      return []
  }
}

/** How far back the source looks for the member chain before the cursor. */
const CHAIN_LOOKBEHIND = 500

/** Inside the quotes of `require('…')` / `al.require('…')`. */
const REQUIRE_ARGUMENT = /(?<![\w$.])(?:al\s*\.\s*)?require\s*\(\s*['"`]([\w@:/.-]*)$/

/** Modules and their members: `require('|')`, `const { v4| } = require('uuid')`
 * and members of a variable bound to a bundled module (`_.`, `CryptoJS.enc.`,
 * `moment().`). `null` when the cursor is in none of these places; no
 * options for a module whose members are unknown (`npm:` packages). */
function moduleCompletions(context: CompletionContext): CompletionResult | null {
  const before = context.state.sliceDoc(Math.max(0, context.pos - CHAIN_LOOKBEHIND), context.pos)

  const argument = REQUIRE_ARGUMENT.exec(before)
  if (argument) return { from: context.pos - argument[1].length, options: MODULE_NAME_COMPLETIONS, validFor: /^[\w@:/.-]*$/ }

  const partial = /[\w$]*$/.exec(before)?.[0] ?? ''
  const destructured = destructuredModule(before, context.state.sliceDoc(context.pos, context.pos + CHAIN_LOOKBEHIND))
  if (destructured !== null) return { from: context.pos - partial.length, options: moduleMembers(destructured), validFor: /^[\w$]*$/ }

  const chain = memberChainBefore(before)
  if (!chain) return null
  const options = moduleChainMembers(chain.segments, requiredModules(context.state.sliceDoc(0, context.pos)))
  if (options === null) return null
  return { from: context.pos - chain.partial.length, options, validFor: /^[\w$]*$/ }
}

export function completionSource(phase: ScriptPhase) {
  return (context: CompletionContext): CompletionResult | null => {
    const modules = moduleCompletions(context)
    if (modules) return modules.options.length > 0 ? modules : null

    const word = context.matchBefore(/[\w$.]*/)
    if (!word) return null
    const segments = word.text.split('.')
    const partial = segments.pop() ?? ''
    const path = segments.join('.')
    const from = word.to - partial.length

    if (path === '') {
      // No dot: offers `al` and `require` once at least one letter is typed,
      // or right away when the list is opened by the shortcut.
      if (partial === '' && !context.explicit) return null
      return {
        from,
        options: [{ label: 'al', type: 'variable', detail: 'Alcy', info: 'Objeto com a API de scripts do Alcy.' }, requireCompletion],
      }
    }

    const options = membersOf(path, phase)
    return options.length > 0 ? { from, options, validFor: /^\w*$/ } : null
  }
}

/** Add al completions alongside JavaScript suggestions; completionShortcutsExtension owns acceptance/toggling shortcuts. */
export function scriptCompletionExtension(phase: ScriptPhase): Extension {
  return [
    autocompletion({ icons: false, activateOnCompletion: (completion) => completion === requireCompletion && automaticSuggestionsEnabled() }),
    javascriptLanguage.data.of({ autocomplete: completionSource(phase) }),
    completionTheme,
    floatingTooltips(),
  ]
}
