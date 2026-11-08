#!/usr/bin/env node
// Publishes this machine's signed build to the update source set by
// ALCY_UPDATE_PROVIDER and ALCY_UPDATE_URL (environment or `.env`; see
// scripts/build-env.mjs and ADR 0026).
//
// For every provider, the updater manifest `latest.json` is merged with what
// another platform already published for the same version, so Windows, Linux
// and macOS can publish from different machines.
//
// - github: installers and manifest as assets of release `vX.Y.Z`.
//   Env: GITHUB_TOKEN (contents: write permission).
// - releaseServer: installers and manifest on the own release service; the
//   manifest goes last and is what publishes the version.
//   Env: ALCY_RELEASES_TOKEN.
// - manifest: writes latest.json in the bundle folder pointing to the
//   manifest's own folder; you upload the files to the hosting.
//
// Usage (after `pnpm release:build`, or `release:build:macos` on a Mac, with
// TAURI_SIGNING_PRIVATE_KEY set):
//   pnpm release:publish [--notes-file NOTES.md] [--dry-run] [--bundle-dir <folder>]

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { loadDotEnv, updateSourceFromEnv } from './build-env.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = 'alcy'
const MANIFEST_NAME = 'latest.json'

function fail(message) {
  console.error(`erro: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  // On macOS, release builds are universal (see `release:build:macos`).
  const target = process.platform === 'darwin' ? ['universal-apple-darwin', 'release'] : ['release']
  const args = { dryRun: false, notesFile: null, bundleDir: join(ROOT, 'target', ...target, 'bundle') }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--notes-file') args.notesFile = argv[++index]
    else if (arg === '--bundle-dir') args.bundleDir = argv[++index]
    else fail(`argumento desconhecido: ${arg}`)
  }
  return args
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) fail(`defina a variável de ambiente ${name}`)
  return value
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`não foi possível ler ${path}: ${error.message}`)
  }
}

/** macOS arch in the DMG name (`Alcy_1.2.3_universal.dmg`) → updater platforms. */
const MACOS_PLATFORMS = {
  universal: ['darwin-x86_64', 'darwin-aarch64', 'darwin-x86_64-app', 'darwin-aarch64-app'],
  aarch64: ['darwin-aarch64', 'darwin-aarch64-app'],
  x64: ['darwin-x86_64', 'darwin-x86_64-app'],
}

/**
 * macOS: the DMG is uploaded for first installs (no manifest entry); the
 * updater archive `Alcy.app.tar.gz` has no version or arch in its name, so it
 * is checked against the bundle's Info.plist and uploaded as
 * `Alcy_<version>_<arch>.app.tar.gz`.
 */
function findMacosArtifacts(bundleDir, version) {
  const dmgDir = join(bundleDir, 'dmg')
  const appDir = join(bundleDir, 'macos')
  const pattern = new RegExp(`^(.+)_${version.replaceAll('.', '\\.')}_(universal|aarch64|x64)\\.dmg$`)
  const dmgs = existsSync(dmgDir)
    ? readdirSync(dmgDir).map((file) => ({ file, match: pattern.exec(file) })).filter(({ match }) => match)
    : []
  const archives = existsSync(appDir) ? readdirSync(appDir).filter((file) => file.endsWith('.app.tar.gz')) : []
  if (archives.length > 0 && dmgs.length !== 1) {
    fail(`${appDir} tem pacote de atualização, mas ${dmgDir} precisa ter exatamente um .dmg da versão ${version}. Gere o build com "pnpm release:build:macos".`)
  }
  const artifacts = dmgs.map(({ file }) => ({ path: join(dmgDir, file), signaturePath: null, name: file, platforms: [] }))
  for (const archive of archives) {
    const [, product, arch] = dmgs[0].match
    const app = archive.slice(0, -'.tar.gz'.length)
    const plist = join(appDir, app, 'Contents', 'Info.plist')
    const built = existsSync(plist)
      ? /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(plist, 'utf8'))?.[1]
      : undefined
    if (built !== version) {
      fail(`${archive} é da versão ${built ?? 'desconhecida'} (${plist}), não da ${version}. Gere o build de novo.`)
    }
    const path = join(appDir, archive)
    const signaturePath = `${path}.sig`
    if (!existsSync(signaturePath)) {
      fail(`${archive} não tem assinatura (${basename(signaturePath)}). Gere o build com "pnpm release:build:macos" e TAURI_SIGNING_PRIVATE_KEY definido.`)
    }
    artifacts.push({ path, signaturePath, name: `${product}_${version}_${arch}.app.tar.gz`, platforms: MACOS_PLATFORMS[arch] })
  }
  return artifacts
}

/** Installer + signature of each updatable format found in the bundle. */
function findArtifacts(bundleDir, version) {
  const formats = [
    { dir: 'nsis', suffix: '-setup.exe', platforms: ['windows-x86_64-nsis', 'windows-x86_64'] },
    { dir: 'msi', suffix: '.msi', platforms: ['windows-x86_64-msi'] },
    { dir: 'appimage', suffix: '.AppImage', platforms: ['linux-x86_64-appimage', 'linux-x86_64'] },
  ]
  const artifacts = []
  for (const format of formats) {
    const dir = join(bundleDir, format.dir)
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir)) {
      if (!file.includes(`_${version}_`) || !file.endsWith(format.suffix)) continue
      const path = join(dir, file)
      const signaturePath = `${path}.sig`
      if (!existsSync(signaturePath)) {
        fail(`${file} não tem assinatura (${basename(signaturePath)}). Gere o build com "pnpm release:build" e TAURI_SIGNING_PRIVATE_KEY definido.`)
      }
      artifacts.push({ path, signaturePath, name: file, platforms: format.platforms })
    }
  }
  return [...artifacts, ...findMacosArtifacts(bundleDir, version)]
}

/** Updater manifest with this build's platforms added to the published ones. */
function buildManifest({ version, previous, notesFile, artifacts, urlFor }) {
  const notes = notesFile ? readFileSync(notesFile, 'utf8').trim() : previous?.notes ?? `Alcy ${version}`
  const manifest = {
    version,
    notes,
    pub_date: previous?.pub_date ?? new Date().toISOString(),
    platforms: { ...(previous?.version === version ? previous.platforms : {}) },
  }
  for (const artifact of artifacts.filter((artifact) => artifact.platforms.length > 0)) {
    const entry = { url: urlFor(artifact.name), signature: readFileSync(artifact.signaturePath, 'utf8').trim() }
    for (const platform of artifact.platforms) manifest.platforms[platform] = entry
  }
  return manifest
}

function releaseRef() {
  return process.env.RELEASE_REF?.trim() || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
}

/** Minimal HTTP client: fails with a clear message and writes nothing in dry-run. */
function createHttp({ headers, dryRun, schemeHint }) {
  async function request(method, url, { body, json, allow404 = false, extraHeaders = {} } = {}) {
    const allHeaders = { ...headers, ...extraHeaders }
    if (json !== undefined) allHeaders['Content-Type'] = 'application/json'
    let response
    try {
      response = await fetch(url, { method, headers: allHeaders, body: json !== undefined ? JSON.stringify(json) : body })
    } catch (error) {
      const cause = error.cause ?? error
      // TLS talking to a server that answers plain HTTP on this port.
      const plainHttp = cause.code === 'ERR_SSL_PACKET_LENGTH_TOO_LONG' || cause.code === 'ERR_SSL_WRONG_VERSION_NUMBER'
      const hint = plainHttp && schemeHint ? ` O servidor parece não usar HTTPS: ${schemeHint}` : ''
      fail(`não foi possível conectar a ${new URL(url).origin} (${cause.code ?? cause.message}).${hint}`)
    }
    if (allow404 && response.status === 404) return null
    if (!response.ok) {
      const text = await response.text()
      fail(`${method} ${url} respondeu HTTP ${response.status}: ${text.slice(0, 300)}`)
    }
    if (response.status === 204) return null
    const type = response.headers.get('content-type') ?? ''
    return type.includes('application/json') ? response.json() : response.text()
  }

  return {
    get: (url, options) => request('GET', url, options),
    async write(method, url, options) {
      if (dryRun) {
        console.log(`[dry-run] ${method} ${url}`)
        return null
      }
      return request(method, url, options)
    },
  }
}

async function publishGithub({ source, version, tag, artifacts, args }) {
  const repository = (process.env.GITHUB_REPOSITORY?.trim() || source.url)
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  const api = `https://api.github.com/repos/${repository}`
  const http = createHttp({
    headers: {
      Authorization: `Bearer ${requiredEnv('GITHUB_TOKEN')}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    dryRun: args.dryRun,
  })
  const downloadUrl = (file) => `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(file)}`
  console.log(`GitHub: repositório ${repository}, versão ${version}`)

  let release = await http.get(`${api}/releases/tags/${encodeURIComponent(tag)}`, { allow404: true })
  const existingAsset = (name) => release?.assets?.find((asset) => asset.name === name)

  // Manifest already published in this release (another platform), to merge.
  const manifestAsset = existingAsset(MANIFEST_NAME)
  const existing = manifestAsset
    ? await http.get(`${api}/releases/assets/${manifestAsset.id}`, { extraHeaders: { Accept: 'application/octet-stream' } })
    : null
  const previous = typeof existing === 'string' ? JSON.parse(existing) : existing
  const manifest = buildManifest({ version, previous, notesFile: args.notesFile, artifacts, urlFor: downloadUrl })

  if (!release) {
    const ref = releaseRef()
    console.log(`Criando a release ${tag} a partir de ${ref}…`)
    release = await http.write('POST', `${api}/releases`, {
      json: { tag_name: tag, target_commitish: ref, name: `Alcy ${version}`, body: manifest.notes },
    })
  } else if (args.notesFile) {
    await http.write('PATCH', `${api}/releases/${release.id}`, { json: { body: manifest.notes } })
  }

  // Assets with the same name are replaced (the API does not overwrite).
  const upload = async (name, body) => {
    const current = existingAsset(name)
    if (current) await http.write('DELETE', `${api}/releases/assets/${current.id}`)
    console.log(`Enviando ${name}…`)
    const uploadUrl = release
      ? `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`
      : `https://uploads.github.com/repos/${repository}/releases/<nova>/assets?name=${encodeURIComponent(name)}`
    await http.write('POST', uploadUrl, { body, extraHeaders: { 'Content-Type': 'application/octet-stream' } })
  }
  for (const artifact of artifacts) await upload(artifact.name, readFileSync(artifact.path))
  console.log(`Plataformas no ${MANIFEST_NAME}: ${Object.keys(manifest.platforms).join(', ')}`)
  await upload(MANIFEST_NAME, JSON.stringify(manifest, null, 2))

  console.log(`Release ${tag} publicada: https://github.com/${repository}/releases/tag/${tag}`)
}

async function publishReleaseServer({ source, version, artifacts, args }) {
  const base = source.url.trim().replace(/\/+$/, '')
  const http = createHttp({
    headers: { Authorization: `Bearer ${requiredEnv('ALCY_RELEASES_TOKEN')}` },
    dryRun: args.dryRun,
    schemeHint: 'use http:// em ALCY_UPDATE_URL.',
  })
  const fileUrl = (file) => `${base}/v1/releases/${version}/files/${encodeURIComponent(file)}`
  console.log(`Servidor de releases: ${base}, versão ${version}`)

  // 1. Installers (signatures go inside the manifest, not as files).
  for (const artifact of artifacts) {
    console.log(`Enviando ${artifact.name}…`)
    await http.write('PUT', fileUrl(artifact.name), {
      body: readFileSync(artifact.path),
      extraHeaders: { 'Content-Type': 'application/octet-stream' },
    })
  }

  // 2. Manifest last: only then does the version show up for the app. Merged
  // with the platforms already published for this version.
  const existing = await http.get(fileUrl(MANIFEST_NAME), { allow404: true })
  const previous = typeof existing === 'string' ? JSON.parse(existing) : existing
  const manifest = buildManifest({ version, previous, notesFile: args.notesFile, artifacts, urlFor: fileUrl })
  console.log(`Enviando ${MANIFEST_NAME} (${Object.keys(manifest.platforms).join(', ')})…`)
  await http.write('PUT', fileUrl(MANIFEST_NAME), {
    body: JSON.stringify(manifest, null, 2),
    extraHeaders: { 'Content-Type': 'application/json' },
  })

  console.log(`Release ${version} publicada: ${base}/`)
}

function writeManifestLocally({ source, version, artifacts, args }) {
  const base = source.url.slice(0, source.url.lastIndexOf('/') + 1)
  const target = join(args.bundleDir, MANIFEST_NAME)
  const previous = existsSync(target) ? readJson(target) : null
  const manifest = buildManifest({ version, previous, notesFile: args.notesFile, artifacts, urlFor: (file) => `${base}${encodeURIComponent(file)}` })

  if (args.dryRun) console.log(`[dry-run] gravaria ${target}`)
  else writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Manifesto: ${target} (${Object.keys(manifest.platforms).join(', ')})`)
  console.log(`Envie para ${base}:`)
  for (const artifact of artifacts) {
    const renamed = basename(artifact.path) === artifact.name ? '' : ` (como ${artifact.name})`
    console.log(`  - ${artifact.path}${renamed}`)
  }
  console.log(`  - ${target} (como ${source.url.slice(base.length)})`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const config = readJson(join(ROOT, 'src-tauri', 'tauri.conf.json'))
  loadDotEnv()
  let source
  try {
    source = updateSourceFromEnv()
  } catch (error) {
    fail(error.message)
  }
  if (!source) fail('defina ALCY_UPDATE_PROVIDER (no ambiente ou no .env) — não há onde publicar.')
  const version = config.version
  const tag = `v${version}`

  if (!config.plugins?.updater?.pubkey?.trim()) {
    fail('src-tauri/tauri.conf.json não tem plugins.updater.pubkey — builds sem chave pública não conseguem verificar atualizações.')
  }
  const artifacts = findArtifacts(args.bundleDir, version)
  if (artifacts.length === 0) fail(`nenhum instalador assinado da versão ${version} em ${args.bundleDir}`)

  const context = { source, version, tag, artifacts, args }
  switch (source.provider) {
    case 'github':
      return publishGithub(context)
    case 'releaseServer':
      return publishReleaseServer(context)
    case 'manifest':
      return writeManifestLocally(context)
  }
}

await main()
