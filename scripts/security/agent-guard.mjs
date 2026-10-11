// Decisões dos hooks PreToolUse dos agentes (Claude Code e Codex).
// `deny` bloqueia a ação; `ask` exige confirmação humana mesmo que haja regra
// de permissão liberando o comando; `null` segue o fluxo normal de permissões.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'

import {
  AGENT_CONFIRM_PATHS,
  CRATE_MANIFEST,
  REVIEW_TRAILER,
  changedExternalDependencies,
  isSensitiveFile,
  needsAgentConfirmation,
} from './policy.mjs'

const deny = (reason) => ({ decision: 'deny', reason })
const ask = (reason) => ({ decision: 'ask', reason })

// Opções globais do git antes do subcomando (`git -C dir -c k=v commit`).
const GIT = String.raw`\bgit(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+`
// Opções do pnpm antes do subcomando (`pnpm --filter desktop add x`).
const PNPM = String.raw`\bpnpm(?:\s+(?:--filter|-F|-C|--dir)\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+`

const BASH_DENY = [
  [/--no-verify\b/, 'pular os hooks do git'],
  [new RegExp(`${GIT}commit\\b[^\\n;&|]*\\s-[a-zA-Z]*n[a-zA-Z]*(\\s|$)`), '`git commit -n` pula os hooks do git'],
  [/\bHUSKY=0\b|core\.hooksPath/, 'desativar os hooks do git'],
  [new RegExp(`${GIT}push\\b[^\\n;&|]*(\\s--force(-with-lease)?\\b|\\s-[a-zA-Z]*f\\b|\\s\\+\\S)`), 'push forçado reescreve o histórico remoto'],
  [/\b(curl|wget)\b[^\n;&]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|node|python3?|perl|ruby)\b/, 'executar script baixado da internet'],
  [new RegExp(`${PNPM}(run\\s+)?release:`), 'build e publicação de release são feitos por uma pessoa'],
  [/\b(npm|pnpm|yarn|cargo)\s+publish\b/, 'publicar pacote'],
  [/\btauri\s+signer\b/, 'manipular a chave de assinatura de releases'],
  [/TAURI_SIGNING_PRIVATE_KEY|~\/\.tauri\b|\.tauri\/|local-secret\.key|\.ssh\/|\b(GITLAB|GITHUB|CI_JOB)_TOKEN\b/, 'acessar segredos'],
  [/(^|[\s"'=])(?:[^\s"';&|]+\/)*\.env(?!\.example(?:$|[\s"';&|]))(?:\.[^\s"';&|]+)?(?=$|[\s"';&|])/, 'acessar arquivo de ambiente'],
  [/(^|[\s"'=])[^\s"';&|]*\.(key|pem|p12|pfx|jks|keystore)(?=$|[\s"';&|])/i, 'acessar arquivo de chave ou certificado'],
  [new RegExp(`${REVIEW_TRAILER}\\s*:`, 'i'), `o trailer ${REVIEW_TRAILER} só pode ser escrito por uma pessoa`],
  [/disableAllHooks/, 'desativar os hooks dos agentes'],
  [/\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(\/|~|\$HOME)(\s|$)/, 'apagar a raiz ou a home'],
]

const BASH_ASK = [
  [new RegExp(`${GIT}(commit|push|tag|rebase|merge|cherry-pick|am|revert|filter-branch|update-ref)\\b`), 'commit, push e reescrita de histórico exigem confirmação'],
  [new RegExp(`${GIT}(reset\\s+--hard|clean\\s+-\\S*f|branch\\s+-D|stash\\s+(drop|clear)|checkout\\s+--\\s|restore\\s)`), 'operação git que descarta trabalho'],
  [new RegExp(`${PNPM}(add|update|up|upgrade|remove|rm|uninstall|dlx|link|patch|audit\\s+--fix)\\b`), 'mudança de dependências exige confirmação'],
  [new RegExp(`${PNPM}(install|i)\\s+(?!-)\\S`), 'mudança de dependências exige confirmação'],
  [/\bnpx\s|\bnpm\s+(i|install|add|update|exec|ci)\b|\byarn\s+(add|up|dlx)\b/, 'instalar ou executar pacote do registro'],
  [/\bcargo(\s+\+\S+)?\s+(add|update|install|remove|rm)\b/, 'mudança de dependências Rust exige confirmação'],
  [/\bpip3?\s+install\b|\bapt(-get)?\s+install\b|\bsudo\b/, 'instalar software no sistema'],
  [/\brustup\s+(toolchain\s+install|default|override|update)\b/, 'alterar o toolchain Rust'],
  [/--target-dir\b|\bCARGO_(BUILD_)?TARGET_DIR\b|\bbuild\.target-dir\b/, 'usar um diretório de build diferente do configurado'],
]

// Nomes que identificam arquivos protegidos em comandos de shell (inclusive
// quando o agente entra na pasta antes de editá-los).
const PROTECTED_NAMES = [
  ...new Set(
    AGENT_CONFIRM_PATHS.map((entry) => entry.replace(/\/$/, '').split('/').pop()),
  ),
]
const SHELL_WRITE =
  /(>>?\s*\S|\btee\b|\bsed\b[^\n;&|]*\s-[a-zA-Z]*i|\bperl\b[^\n;&|]*\s-[a-zA-Z]*i|\b(mv|cp|rm|truncate|chmod|ln|dd|patch)\s|\bpython3?\s+(-c|-)(\s|$)|\bnode\s+(-e|--eval|-p)\b|\bgit\s+(checkout|restore|apply|stash\s+pop)\b)/

export function decideBash(command) {
  for (const [pattern, reason] of BASH_DENY) {
    if (pattern.test(command)) return deny(`Bloqueado pela política do repositório: ${reason}.`)
  }
  for (const [pattern, reason] of BASH_ASK) {
    if (pattern.test(command)) return ask(`Política do repositório: ${reason}.`)
  }
  if (SHELL_WRITE.test(command)) {
    const touched = PROTECTED_NAMES.filter((name) => command.includes(name))
    if (touched.length > 0) {
      return ask(`Política do repositório: o comando pode alterar arquivos protegidos (${touched.join(', ')}).`)
    }
  }
  return null
}

const HOME_SECRETS = ['.ssh', '.tauri', '.gnupg', '.aws', '.config/gcloud']
const AGENT_SETTINGS = ['.claude/settings.json', '.claude/settings.local.json', '.codex/config.toml']
const CARGO_SETTINGS = ['.cargo/config.toml', '.cargo/config']

function relativeTo(base, path) {
  const rel = relative(base, path)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replace(/\\/g, '/') : null
}

// Conteúdo de um manifesto de crate depois da edição, ou `null` quando não dá
// para calculá-lo (a edição então pede confirmação).
function crateManifestChange(absolute, apply) {
  if (!apply) return null
  const before = existsSync(absolute) ? readFileSync(absolute, 'utf8') : ''
  const after = apply(before)
  return typeof after === 'string' ? changedExternalDependencies(before, after) : null
}

export function decideFile(filePath, { projectDir, home = homedir(), write, apply }) {
  const absolute = resolve(projectDir, filePath)
  const inHome = relativeTo(home, absolute)
  if (isSensitiveFile(absolute) || absolute.endsWith('local-secret.key')) {
    return deny('Bloqueado pela política do repositório: arquivo de segredo.')
  }
  if (inHome && HOME_SECRETS.some((dir) => inHome === dir || inHome.startsWith(`${dir}/`))) {
    return deny('Bloqueado pela política do repositório: diretório de credenciais.')
  }
  if (!write) return null
  if (inHome && AGENT_SETTINGS.includes(inHome)) {
    return ask('Política do repositório: alterar a configuração global do agente exige confirmação.')
  }
  if (inHome && CARGO_SETTINGS.includes(inHome)) {
    return ask('Política do repositório: alterar a configuração global do Cargo exige confirmação.')
  }
  const inProject = relativeTo(projectDir, absolute)
  if (inProject && CRATE_MANIFEST.test(inProject)) {
    const changed = crateManifestChange(absolute, apply)
    if (changed?.length === 0) return null
    return ask(
      changed
        ? `Política do repositório: ${inProject} adiciona ou altera dependências externas (${changed.join(', ')}); exige confirmação humana.`
        : `Política do repositório: não foi possível verificar as dependências de ${inProject}; a edição exige confirmação humana.`,
    )
  }
  if (inProject && needsAgentConfirmation(inProject)) {
    return ask(`Política do repositório: ${inProject} é protegido; a edição exige confirmação humana.`)
  }
  return null
}

export function patchPaths(command) {
  const paths = []
  const headers = /^\*\*\* (?:Add|Delete|Update) File: (.+)$|^\*\*\* Move to: (.+)$/gm
  for (const match of String(command).matchAll(headers)) {
    paths.push((match[1] ?? match[2]).trim())
  }
  return [...new Set(paths)]
}

// Arquivos de um patch do `apply_patch`, com as linhas de cada um.
function patchFiles(command) {
  const files = new Map()
  let current = null
  for (const line of String(command).split('\n')) {
    const header = line.match(/^\*\*\* (Add|Delete|Update) File: (.+)$/)
    if (header) {
      current = { kind: header[1], lines: [], moved: false }
      files.set(header[2].trim(), current)
    } else if (line.startsWith('*** Move to:')) {
      if (current) current.moved = true
    } else if (line.startsWith('*** End of File')) {
      continue
    } else if (line.startsWith('***')) {
      current = null
    } else {
      current?.lines.push(line)
    }
  }
  return files
}

function findLines(lines, target, from) {
  const normalizers = [(line) => line, (line) => line.trimEnd(), (line) => line.trim()]
  for (const normalize of normalizers) {
    for (let start = from; start + target.length <= lines.length; start++) {
      if (target.every((line, offset) => normalize(lines[start + offset]) === normalize(line))) return start
    }
  }
  return -1
}

// Aplica os trechos (`@@`) de um `Update File` como o `apply_patch`: a linha
// após `@@` localiza o ponto de partida; contexto e remoções precisam existir.
function applyHunks(before, patchLines) {
  const hunks = []
  for (const line of patchLines) {
    if (line.startsWith('@@')) {
      hunks.push({ anchor: line.slice(2).trim(), lines: [] })
      continue
    }
    if (hunks.length === 0) hunks.push({ anchor: '', lines: [] })
    hunks.at(-1).lines.push(line)
  }
  const lines = before.split('\n')
  let cursor = 0
  for (const { anchor, lines: body } of hunks) {
    if (anchor) {
      const found = findLines(lines, [anchor], cursor)
      if (found < 0) return null
      cursor = found + 1
    }
    const removed = body.filter((line) => !line.startsWith('+')).map((line) => line.slice(1))
    const added = body.filter((line) => !line.startsWith('-')).map((line) => line.slice(1))
    if (removed.length === 0) {
      lines.splice(lines.length, 0, ...added)
      continue
    }
    const found = findLines(lines, removed, cursor)
    if (found < 0) return null
    lines.splice(found, removed.length, ...added)
    cursor = found + added.length
  }
  return lines.join('\n')
}

// Reproduz o efeito do patch sobre o conteúdo atual de um arquivo; arquivos
// movidos ficam sem conteúdo conhecido.
function patchApplier(file) {
  if (!file || file.moved) return undefined
  if (file.kind === 'Delete') return () => ''
  if (file.kind === 'Add') {
    return () => file.lines.filter((line) => line.startsWith('+')).map((line) => line.slice(1)).join('\n')
  }
  return (before) => applyHunks(before, file.lines)
}

export function decidePatch(command, options) {
  const paths = patchPaths(command)
  if (paths.length === 0) {
    return deny('Bloqueado pela política do repositório: patch sem caminhos reconhecíveis.')
  }
  const files = patchFiles(command)
  let pending = null
  for (const path of paths) {
    const result = decideFile(path, { ...options, write: true, apply: patchApplier(files.get(path)) })
    if (result?.decision === 'deny') return result
    if (result?.decision === 'ask') pending = result
  }
  return pending
}

function replaceText(text, { old_string, new_string, replace_all }) {
  if (typeof old_string !== 'string' || typeof new_string !== 'string' || !text.includes(old_string)) return null
  return replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string)
}

// Reproduz a edição da ferramenta sobre o conteúdo atual do arquivo.
function editApplier(tool, input) {
  if (tool === 'Write') return () => (typeof input.content === 'string' ? input.content : null)
  if (tool === 'Edit') return (before) => replaceText(before, input)
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    return (before) => input.edits.reduce((text, edit) => (text === null ? null : replaceText(text, edit)), before)
  }
  return undefined
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])

export function decide(event, { projectDir, home } = {}) {
  const input = event.tool_input ?? {}
  const root = projectDir ?? event.cwd ?? process.cwd()
  if (event.tool_name === 'Bash') return decideBash(String(input.command ?? ''))
  if (event.tool_name === 'apply_patch') return decidePatch(String(input.command ?? ''), { projectDir: root, home })
  if (WRITE_TOOLS.has(event.tool_name)) {
    const path = input.file_path ?? input.notebook_path
    return path ? decideFile(path, { projectDir: root, home, write: true, apply: editApplier(event.tool_name, input) }) : null
  }
  if (READ_TOOLS.has(event.tool_name)) {
    const path = input.file_path ?? input.path
    return path ? decideFile(path, { projectDir: root, home, write: false }) : null
  }
  return null
}
