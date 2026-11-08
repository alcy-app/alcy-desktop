#!/usr/bin/env node
// Sensor offline das garantias de segurança e privacidade do Alcy: falha se
// uma mudança abrir a WebView para a rede, ampliar as permissões do Tauri,
// introduzir SDK de telemetria, dependência fora dos registros oficiais,
// script de instalação, build script novo, execução de processos fora do
// ponto revisado ou desativação de TLS fora do ponto revisado. Cada
// exceção precisa de revisão e de atualização deste arquivo.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadDotEnv, updateSourceFromEnv } from './build-env.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8')
}

function fail(message) {
  failures.push(message)
}

// --- WebView: CSP e configuração do Tauri --------------------------------

// Destinos que a WebView de produção pode alcançar: só a ponte IPC do Tauri
// e os recursos empacotados. Nenhum host remoto.
const ALLOWED_CSP_SOURCES = new Set([
  "'self'",
  "'unsafe-inline'",
  'ipc:',
  'http://ipc.localhost',
  'asset:',
  'http://asset.localhost',
  'customprotocol:',
  'blob:',
  'data:',
])
const STRICT_DIRECTIVES = {
  'connect-src': new Set(['ipc:', 'http://ipc.localhost']),
  'script-src': new Set(["'self'"]),
}

const tauriConf = JSON.parse(read('src-tauri/tauri.conf.json'))
const security = tauriConf.app?.security ?? {}
const csp = security.csp

if (!csp || typeof csp !== 'object') {
  fail('tauri.conf.json: app.security.csp precisa ser um objeto de diretivas (CSP desativada expõe a WebView à rede).')
} else {
  for (const [directive, value] of Object.entries(csp)) {
    for (const source of String(value).split(/\s+/).filter(Boolean)) {
      if (!ALLOWED_CSP_SOURCES.has(source)) {
        fail(`tauri.conf.json: CSP ${directive} contém origem não permitida "${source}".`)
      }
    }
  }
  for (const [directive, allowed] of Object.entries(STRICT_DIRECTIVES)) {
    const sources = String(csp[directive] ?? '').split(/\s+/).filter(Boolean)
    if (sources.length === 0) fail(`tauri.conf.json: CSP precisa declarar ${directive}.`)
    for (const source of sources) {
      if (!allowed.has(source)) fail(`tauri.conf.json: CSP ${directive} só aceita ${[...allowed].join(' ')}; encontrado "${source}".`)
    }
  }
}

if (security.dangerousDisableAssetCspModification) {
  fail('tauri.conf.json: dangerousDisableAssetCspModification não pode ser habilitado.')
}
if (tauriConf.app?.withGlobalTauri) {
  fail('tauri.conf.json: withGlobalTauri expõe a API do Tauri a qualquer script da página.')
}
for (const window of tauriConf.app?.windows ?? []) {
  if (window.url && /^https?:/i.test(window.url)) {
    fail(`tauri.conf.json: janela "${window.label ?? '?'}" carrega conteúdo remoto (${window.url}).`)
  }
}
// Exceção aceita (spec 0097): enquanto a fonte de releases só tiver HTTP, o
// updater precisa aceitar esse transporte; a integridade vem da assinatura
// minisign. Assim que a fonte usar HTTPS, a exceção deixa de valer. A fonte
// vem de ALCY_UPDATE_PROVIDER/ALCY_UPDATE_URL (ambiente ou `.env`); sem ela o
// build não tem atualizações e a regra não se aplica.
loadDotEnv()
let updateSource = null
try {
  updateSource = updateSourceFromEnv()
} catch (error) {
  fail(`origem de atualizações: ${error.message}`)
}
if (updateSource && tauriConf.plugins?.updater?.dangerousInsecureTransportProtocol && !updateSource.url.startsWith('http://')) {
  fail('tauri.conf.json: o updater só pode aceitar HTTP inseguro enquanto ALCY_UPDATE_URL usar http://.')
}
if (!tauriConf.plugins?.updater?.pubkey) {
  fail('tauri.conf.json: o updater precisa de pubkey para verificar a assinatura dos pacotes.')
}

// --- Permissões concedidas à WebView ---------------------------------------

const ALLOWED_PERMISSIONS = new Set([
  'core:default',
  'core:window:allow-destroy',
  'core:window:allow-minimize',
  'core:window:allow-toggle-maximize',
  'core:window:allow-close',
  'core:window:allow-start-dragging',
  'core:window:allow-is-maximized',
  'dialog:allow-open',
  'dialog:allow-save',
])

const capabilitiesDir = join(ROOT, 'src-tauri/capabilities')
for (const file of readdirSync(capabilitiesDir).filter((name) => name.endsWith('.json'))) {
  const capability = JSON.parse(readFileSync(join(capabilitiesDir, file), 'utf8'))
  if (capability.remote) fail(`capabilities/${file}: permissões para URLs remotas não são permitidas.`)
  for (const permission of capability.permissions ?? []) {
    const id = typeof permission === 'string' ? permission : permission.identifier
    if (!ALLOWED_PERMISSIONS.has(id)) fail(`capabilities/${file}: permissão "${id}" fora da lista revisada.`)
  }
}

// --- Dependências ------------------------------------------------------------

// SDKs de telemetria, analytics ou coleta remota de erros.
const TELEMETRY_PACKAGE =
  /^(@sentry\/|sentry(-|$)|posthog|mixpanel|@segment\/|analytics-node|@amplitude\/|amplitude-js|@datadog\/|dd-trace|bugsnag|@bugsnag\/|logrocket|@opentelemetry\/|opentelemetry|applicationinsights|newrelic|hotjar|@vercel\/analytics|tauri-plugin-(aptabase|sentry)|@aptabase\/)/i

const pnpmLock = read('pnpm-lock.yaml')
const pnpmPackages = new Set(
  [...pnpmLock.matchAll(/^ {2}'?((?:@[^/\s']+\/)?[^@\s':]+)@[^:\s']+'?:\s*$/gm)].map((match) => match[1]),
)
for (const name of pnpmPackages) {
  if (TELEMETRY_PACKAGE.test(name)) fail(`pnpm-lock.yaml: pacote de telemetria "${name}".`)
}
for (const match of pnpmLock.matchAll(/resolution: \{([^}]*)\}/g)) {
  if (!/^\s*integrity: sha512-/.test(match[1])) fail(`pnpm-lock.yaml: resolução fora do registro npm ({${match[1].trim()}}).`)
}

const cargoLock = read('Cargo.lock')
for (const block of cargoLock.split('[[package]]').slice(1)) {
  const name = block.match(/^name = "([^"]+)"/m)?.[1]
  const source = block.match(/^source = "([^"]+)"/m)?.[1]
  if (name && TELEMETRY_PACKAGE.test(name)) fail(`Cargo.lock: crate de telemetria "${name}".`)
  if (source && source !== 'registry+https://github.com/rust-lang/crates.io-index') {
    fail(`Cargo.lock: crate "${name}" vem de fonte não revisada (${source}).`)
  }
}

// pnpm 10 bloqueia scripts de instalação das dependências por padrão; liberar
// algum exige revisão do pacote.
const workspaceConfig = read('pnpm-workspace.yaml')
if (/^\s*(onlyBuiltDependencies|dangerouslyAllowAllBuilds|neverBuiltDependencies)\s*:/m.test(workspaceConfig)) {
  fail('pnpm-workspace.yaml: liberar scripts de instalação de dependências exige revisão e atualização deste sensor.')
}

// --- Builds reproduzíveis -----------------------------------------------------

// O mesmo commit precisa gerar o mesmo conjunto de dependências com o mesmo
// compilador: versões exatas das ferramentas e lockfiles obrigatórios.
const EXACT_VERSION = /^\d+\.\d+\.\d+$/
const toolchainChannel = read('rust-toolchain.toml').match(/^channel\s*=\s*"([^"]+)"/m)?.[1]
if (!toolchainChannel || !EXACT_VERSION.test(toolchainChannel)) {
  fail('rust-toolchain.toml: channel precisa ser uma versão exata do Rust (ex.: "1.95.0"), não "stable".')
}
if (!EXACT_VERSION.test(read('.node-version').trim())) {
  fail('.node-version: precisa conter uma versão exata do Node (ex.: 24.11.1).')
}
const rootPackage = JSON.parse(read('package.json'))
if (!/^pnpm@\d+\.\d+\.\d+$/.test(rootPackage.packageManager ?? '')) {
  fail('package.json: packageManager precisa fixar a versão exata do pnpm.')
}
const releaseBuild = rootPackage.scripts?.['release:build'] ?? ''
for (const required of ['check-release-toolchain.mjs', 'pnpm install --frozen-lockfile', '-- --locked']) {
  if (!releaseBuild.includes(required)) fail(`package.json: release:build precisa incluir "${required}".`)
}
const ciWorkflow = read('.github/workflows/check.yml')
for (const required of ['pnpm install --frozen-lockfile', 'cargo metadata --locked', 'node-version-file: .node-version']) {
  if (!ciWorkflow.includes(required)) fail(`.github/workflows/check.yml: precisa incluir "${required}".`)
}
for (const workflow of readdirSync(join(ROOT, '.github', 'workflows')).filter((file) => /\.ya?ml$/.test(file))) {
  for (const match of read(`.github/workflows/${workflow}`).matchAll(/uses:\s*([^\s#]+)/g)) {
    if (!/@[0-9a-f]{40}$/.test(match[1])) fail(`.github/workflows/${workflow}: action "${match[1]}" must be pinned by SHA.`)
  }
}

// --- Harness dos agentes ------------------------------------------------------

const agentSettings = JSON.parse(read('.claude/settings.json'))
const guardHooks = (agentSettings.hooks?.PreToolUse ?? []).flatMap((entry) =>
  (entry.hooks ?? []).filter((hook) => String(hook.command).includes('.claude/hooks/guard.mjs')).map(() => entry.matcher),
)
for (const tool of ['Bash', 'Edit', 'Write', 'Read']) {
  if (!guardHooks.some((matcher) => new RegExp(`^(${matcher})$`).test(tool))) {
    fail(`.claude/settings.json: o hook de segurança precisa cobrir a ferramenta ${tool}.`)
  }
}
if (agentSettings.disableAllHooks) fail('.claude/settings.json: disableAllHooks desativa o hook de segurança.')
const codexConfig = read('.codex/config.toml')
for (const required of [
  'default_permissions = "alcy-workspace"',
  '[features]\nhooks = true',
  'extends = ":workspace"',
  '"~/.ssh" = "deny"',
  '"~/.tauri" = "deny"',
  '"**/.env" = "deny"',
  '"apps/desktop/.env.example" = "write"',
  '"**/*.key" = "deny"',
  '[permissions.alcy-workspace.network]\nenabled = false',
]) {
  if (!codexConfig.includes(required)) fail('.codex/config.toml: configuração obrigatória ausente: ' + required + '.')
}
if (/^\s*sandbox_mode\s*=/m.test(codexConfig)) {
  fail('.codex/config.toml: sandbox_mode legado não pode ser combinado com perfis de permissão.')
}

const codexHooks = JSON.parse(read('.codex/hooks.json'))
const codexGuardHooks = (codexHooks.hooks?.PreToolUse ?? []).flatMap((entry) =>
  (entry.hooks ?? []).filter((hook) => String(hook.command).includes('.codex/hooks/guard.mjs')).map(() => entry.matcher),
)
for (const tool of ['Bash', 'apply_patch']) {
  if (!codexGuardHooks.some((matcher) => new RegExp('^(' + matcher + ')$').test(tool))) {
    fail('.codex/hooks.json: o hook de segurança precisa cobrir a ferramenta ' + tool + '.')
  }
}
for (const entry of codexHooks.hooks?.PreToolUse ?? []) {
  for (const hook of entry.hooks ?? []) {
    const command = String(hook.command ?? '')
    if (command.includes('.codex/hooks/guard.mjs') && !command.includes('git rev-parse --show-toplevel')) {
      fail('.codex/hooks.json: o caminho do guarda precisa ser relativo à raiz do repositório.')
    }
  }
}

for (const hook of ['pre-commit', 'commit-msg']) {
  const script = read(`.husky/${hook}`)
  const expected = hook === 'pre-commit' ? 'scripts/security/check-staged.mjs' : 'scripts/security/check-commit-msg.mjs'
  if (!script.includes(expected)) fail(`.husky/${hook}: precisa chamar ${expected}.`)
}

// --- Código Rust do workspace -------------------------------------------------

function collectFiles(dir, predicate, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'target' || entry === 'node_modules' || entry === 'gen') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectFiles(full, predicate, out)
    else if (predicate(entry)) out.push(full)
  }
  return out
}

const rustRoots = ['crates', 'src-tauri'].map((dir) => join(ROOT, dir))
const buildScripts = rustRoots
  .flatMap((dir) => collectFiles(dir, (name) => name === 'build.rs'))
  .map((path) => relative(ROOT, path))
for (const script of buildScripts) {
  if (script !== 'src-tauri/build.rs') fail(`${script}: build script novo roda código na máquina de build e exige revisão.`)
}
if (read('src-tauri/build.rs').replace(/\s+/g, ' ').trim() !== 'fn main() { tauri_build::build() }') {
  fail('src-tauri/build.rs: mudou; build scripts rodam código na máquina de build e exigem revisão.')
}

// Agentes alteram manifestos de crates sem confirmação; cada crate precisa
// continuar herdando os lints do workspace (`unsafe_code = "forbid"`).
for (const entry of readdirSync(join(ROOT, 'crates'))) {
  const manifest = join(ROOT, 'crates', entry, 'Cargo.toml')
  if (!existsSync(manifest)) continue
  if (!/^\[lints\]\s*\nworkspace\s*=\s*true\s*$/m.test(readFileSync(manifest, 'utf8'))) {
    fail(`crates/${entry}/Cargo.toml: precisa herdar os lints do workspace ([lints] workspace = true).`)
  }
}

const FORBIDDEN_RUST = [
  [/\b(std::process::Command|tokio::process|process::Command)\b/, 'execução de processos'],
]
// Single reviewed exception (ADR 0074): the system's `git`, for the
// operations that talk to a remote. One use, in this file, with the
// arguments built as a vector and the `ext::`/`fd::` transports disabled.
// A second use, or any other file, needs a new review.
const PROCESS_EXCEPTION = 'crates/alcy-git/src/cli.rs'
for (const file of rustRoots.flatMap((dir) => collectFiles(dir, (name) => name.endsWith('.rs')))) {
  const path = relative(ROOT, file).split(sep).join('/')
  let allowed = path === PROCESS_EXCEPTION ? 1 : 0
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith('//')) return
    for (const [pattern, reason] of FORBIDDEN_RUST) {
      if (!pattern.test(line)) continue
      if (allowed > 0) {
        allowed -= 1
        continue
      }
      fail(`${path}:${index + 1}: ${reason} exige revisão de segurança.`)
    }
  })
}
const processException = readFileSync(join(ROOT, PROCESS_EXCEPTION), 'utf8')
for (const guard of ['protocol.ext.allow=never', 'protocol.fd.allow=never', 'GIT_TERMINAL_PROMPT', 'kill_on_drop(true)', 'Stdio::null()']) {
  if (!processException.includes(guard)) fail(`${PROCESS_EXCEPTION}: perdeu a proteção \`${guard}\` da execução do git (ADR 0074).`)
}

// A verificação de certificado só pode ser desligada num ponto revisado: o
// cliente compartilhado dos executores de chamadas do usuário, atrás da
// preferência explícita da seção Rede (ADR 0058). Qualquer outro uso, um
// segundo uso no mesmo arquivo ou desligar só a checagem de hostname exige
// nova revisão. Vale também para os serviços do workspace.
const TLS_VERIFICATION_EXCEPTION = 'crates/alcy-http-proxy/src/client.rs'
const tlsRoots = [...rustRoots]
for (const file of tlsRoots.flatMap((dir) => collectFiles(dir, (name) => name.endsWith('.rs')))) {
  const path = relative(ROOT, file).split(sep).join('/')
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => !line.trimStart().startsWith('//'))
  const certUses = lines.filter(({ line }) => /danger_accept_invalid_certs/.test(line))
  const hostnameUses = lines.filter(({ line }) => /danger_accept_invalid_hostnames/.test(line))
  const allowed = path === TLS_VERIFICATION_EXCEPTION ? 1 : 0
  for (const { number } of [...certUses.slice(allowed), ...hostnameUses]) {
    fail(`${path}:${number}: desativação da validação TLS fora do ponto revisado (${TLS_VERIFICATION_EXCEPTION}, ADR 0058) exige revisão de segurança.`)
  }
}

if (failures.length > 0) {
  console.error('Invariantes de segurança violadas:')
  for (const message of failures) console.error(`  - ${message}`)
  process.exit(1)
}
