// Política única de segurança do repositório, compartilhada pelos hooks do git
// (pre-commit e commit-msg), pelos hooks dos agentes (.claude e .codex) e pelo
// pipeline.

/**
 * Arquivos que definem as garantias de segurança do app e do próprio harness.
 * Commits que os alteram exigem o trailer `Security-Review: <nome>`, escrito
 * por uma pessoa depois de revisar a mudança. Entradas terminadas em `/` cobrem
 * a pasta inteira.
 */
export const PROTECTED_PATHS = [
  // App: WebView, permissões, updater e build nativo
  'src-tauri/tauri.conf.json',
  'src-tauri/tauri.release.conf.json',
  // Extra Tauri configs merged with `tauri build --config` (e.g. a downstream build's)
  'src-tauri/config/',
  'src-tauri/capabilities/',
  'src-tauri/update-source.json',
  'src-tauri/build.rs',
  // Cadeia de suprimentos e toolchain
  'deny.toml',
  'pnpm-workspace.yaml',
  'rust-toolchain.toml',
  '.node-version',
  'package.json',
  'Cargo.toml',
  '.gitignore',
  // Sensores, release e harness
  'scripts/check-security-invariants.mjs',
  'scripts/check-release-toolchain.mjs',
  'scripts/publish-release.mjs',
  'scripts/security/',
  '.husky/',
  '.claude/settings.json',
  '.claude/hooks/',
  '.codex/',
  '.github/workflows/',
  '.gitlab-ci.yml',
]

/**
 * Arquivos que um agente só edita com confirmação humana: os protegidos, as
 * diretrizes dos agentes, a configuração do Cargo (diretório de build) e os
 * manifestos de dependências de qualquer pacote.
 */
export const AGENT_CONFIRM_PATHS = [
  ...PROTECTED_PATHS,
  'AGENTS.md',
  'CLAUDE.md',
  'apps/desktop/AGENTS.md',
  'crates/AGENTS.md',
  '.claude/',
  '.agents/',
  '.cargo/',
  '.codex/',
  'pnpm-lock.yaml',
  'Cargo.lock',
]
export const DEPENDENCY_MANIFEST = /(^|\/)(Cargo\.toml|package\.json)$/

/**
 * Manifestos dos crates do workspace. Agentes podem criá-los e alterá-los sem
 * confirmação desde que não adicionem nem alterem dependências externas.
 */
export const CRATE_MANIFEST = /^crates\/[^/]+\/Cargo\.toml$/

const DEPENDENCY_TABLE = /(^|\.)(dev-|build-)?dependencies$/
const DEPENDENCY_ENTRY_TABLE = /(^|\.)(dev-|build-)?dependencies\.([^.]+)$/

/**
 * Dependências externas declaradas num Cargo.toml, como `seção/nome = spec`.
 * Dependências por `path` são código do próprio repositório e ficam de fora.
 * O parser é deliberadamente simples: um formato não reconhecido muda a spec
 * e cai na confirmação humana.
 */
export function externalDependencies(toml) {
  const specs = new Map()
  let section = null
  let pending = null
  const add = (key, text) => specs.set(key, `${specs.get(key) ?? ''}${text.trim()};`)
  const balanced = (text) => {
    const count = (char) => text.split(char).length - 1
    return count('{') === count('}') && count('[') === count(']')
  }
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim()
    if (pending) {
      pending.text += ` ${line}`
      if (balanced(pending.text)) {
        add(pending.key, pending.text)
        pending = null
      }
      continue
    }
    if (!line || line.startsWith('#')) continue
    const header = line.match(/^\[\[?([^\]]+)\]\]?/)
    if (header) {
      const name = header[1].replace(/\s+/g, '')
      const entry = name.match(DEPENDENCY_ENTRY_TABLE)
      if (entry) section = { key: `${name.slice(0, -entry[3].length - 1)}/${entry[3]}` }
      else if (DEPENDENCY_TABLE.test(name)) section = { table: name }
      else section = null
      continue
    }
    if (!section) continue
    if (section.key) {
      add(section.key, line)
      continue
    }
    const key = line.match(/^["']?([\w-]+)/)?.[1] ?? line
    const entry = { key: `${section.table}/${key}`, text: line }
    if (balanced(line)) add(entry.key, entry.text)
    else pending = entry
  }
  if (pending) add(pending.key, pending.text)
  return new Map([...specs].filter(([, spec]) => !/\bpath\s*=/.test(spec)))
}

/** Dependências externas novas ou alteradas entre duas versões do manifesto. */
export function changedExternalDependencies(before, after) {
  const previous = externalDependencies(before)
  return [...externalDependencies(after)]
    .filter(([key, spec]) => previous.get(key) !== spec)
    .map(([key]) => key)
}

/** Arquivos que nunca devem ser versionados nem escritos por agentes. */
export function isSensitiveFile(path) {
  const name = path.split('/').pop() ?? ''
  if (name === '.env.example') return false
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    /\.(key|pem|p12|pfx|jks|keystore)$/i.test(name) ||
    /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(name)
  )
}

/** Padrões de segredo procurados nas linhas adicionadas. */
export const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'chave privada'],
  [/untrusted comment: .*secret key/i, 'chave secreta minisign (assinatura de releases)'], // security:allow-secret
  // Mesma chave em base64, como fica em TAURI_SIGNING_PRIVATE_KEY.
  [/dW50cnVzdGVkIGNvbW1lbnQ6I(HJzaWdu|G1pbmlzaWdu)IGVuY3J5cHRlZCBzZWNyZXQga2V5/, 'chave secreta de assinatura do Tauri'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/, 'token pessoal do GitLab'],
  [/\bgl(dt|rt|ptt|cbt|oas|soat|ft)-[A-Za-z0-9_-]{20,}/, 'token do GitLab'],
  [/\b(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36}\b/, 'token do GitHub'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/, 'token do GitHub'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'chave de acesso AWS'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'token do Slack'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'chave de API da Anthropic'],
  [/\bsk-(proj-)?[A-Za-z0-9]{32,}/, 'chave de API'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'chave de API do Google'],
  [/TAURI_SIGNING_PRIVATE_KEY_PASSWORD\s*[=:]\s*["'][^"'$<]{4,}["']/, 'senha da chave de assinatura do Tauri'],
]

/** Marcador de exceção para fixtures de teste; fica visível na revisão. */
export const SECRET_ALLOW_MARKER = 'security:allow-secret'

export const REVIEW_TRAILER = 'Security-Review'

/** Nomes que indicam que o trailer não foi escrito por uma pessoa. */
export const AUTOMATED_REVIEWER = /\b(claude|codex|copilot|gpt|gemini|cursor|agent|bot|ai|llm|assistant)\b/i

function normalize(path) {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

export function matchesAny(path, entries) {
  const normalized = normalize(path)
  return entries.some((entry) =>
    entry.endsWith('/') ? normalized.startsWith(entry) : normalized === entry,
  )
}

export function isProtected(path) {
  return matchesAny(path, PROTECTED_PATHS)
}

export function needsAgentConfirmation(path) {
  const normalized = normalize(path)
  return matchesAny(normalized, AGENT_CONFIRM_PATHS) || DEPENDENCY_MANIFEST.test(normalized)
}

export function findSecrets(line) {
  if (line.includes(SECRET_ALLOW_MARKER)) return []
  return SECRET_PATTERNS.filter(([pattern]) => pattern.test(line)).map(([, label]) => label)
}

/**
 * Retorna o valor do trailer de revisão, ou `null` quando ausente, vazio ou
 * atribuído a uma ferramenta automatizada.
 */
export function humanReviewer(message) {
  const lines = message.split('\n').filter((line) => !line.startsWith('#'))
  for (const line of lines) {
    const match = line.match(new RegExp(`^${REVIEW_TRAILER}:\\s*(.+?)\\s*$`, 'i'))
    if (match && !AUTOMATED_REVIEWER.test(match[1])) return match[1]
  }
  return null
}

/**
 * Mudanças em `tauri.conf.json` que só alteram `version` não exigem revisão
 * de segurança (o release sobe a versão a cada publicação).
 */
export function isVersionOnlyChange(path, before, after) {
  if (normalize(path) !== 'src-tauri/tauri.conf.json' || before === null || after === null) return false
  try {
    const strip = (text) => {
      const json = JSON.parse(text)
      delete json.version
      return JSON.stringify(json)
    }
    return strip(before) === strip(after)
  } catch {
    return false
  }
}
