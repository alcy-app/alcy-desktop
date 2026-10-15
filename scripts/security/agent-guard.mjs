// Decisions of the agents' PreToolUse hooks (Claude Code and Codex).
// `deny` blocks the action; `ask` requires human confirmation even when a
// permission rule allows the command; `null` follows the normal permission flow.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

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

// Global git options before the subcommand (`git -C dir -c k=v commit`).
const GIT = String.raw`\bgit(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+`
// pnpm options before the subcommand (`pnpm --filter desktop add x`).
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

// Names that identify protected files in shell commands (including when the
// agent changes into the folder before editing them).
const PROTECTED_NAMES = [
  ...new Set(
    AGENT_CONFIRM_PATHS.map((entry) => entry.replace(/\/$/, '').split('/').pop()),
  ),
]
// Agent worktrees live under `.claude/worktrees/<name>/` and follow the same
// rules as the main checkout, so that prefix alone does not make a path
// protected; what follows it is still checked.
const WORKTREE_PREFIX = /\.claude\/worktrees\/(?!\.\.?\/)[^/\s"';&|]+\//g
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
    const target = command.replace(WORKTREE_PREFIX, '')
    const touched = PROTECTED_NAMES.filter((name) => target.includes(name))
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

// Path relative to the checkout that contains `absolute`: the agent worktree
// under `.claude/worktrees/<name>/` when it is inside one, else the project.
function checkoutRelative(projectDir, absolute) {
  const inProject = relativeTo(projectDir, absolute)
  const worktree = inProject?.match(/^\.claude\/worktrees\/([^/]+)\//)
  return worktree ? relativeTo(join(projectDir, '.claude', 'worktrees', worktree[1]), absolute) : inProject
}

// Content of a crate manifest after the edit, or `null` when it cannot be
// computed (the edit then asks for confirmation).
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
  const inProject = checkoutRelative(projectDir, absolute)
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

// Files of an `apply_patch` patch, with the lines of each one.
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

// Applies the hunks (`@@`) of an `Update File` like `apply_patch` does: the line
// after `@@` locates the starting point; context and removals must exist.
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

// Reproduces the patch's effect on a file's current content; moved files have
// no known content.
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

// Reproduces the tool's edit on the file's current content.
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
