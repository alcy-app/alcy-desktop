#!/usr/bin/env node
// Publica o build assinado desta máquina na origem de atualizações definida
// por ALCY_UPDATE_PROVIDER e ALCY_UPDATE_URL (no ambiente ou no `.env`; ver
// scripts/build-env.mjs e ADR 0026).
//
// Em todos os provedores, o manifesto `latest.json` do updater é mesclado com
// o que outra plataforma já publicou para a mesma versão, para que Windows e
// Linux possam publicar de máquinas diferentes.
//
// - gitlab: instaladores e manifesto no Generic Package Registry do projeto
//   (pacote `alcy`); a release `vX.Y.Z` recebe asset links para eles.
//   Env: GITLAB_TOKEN (escopo api). GITLAB_URL e GITLAB_PROJECT são deduzidos
//   de ALCY_UPDATE_URL (defina-os se a instância estiver num subcaminho).
// - github: instaladores e manifesto como assets da release `vX.Y.Z`.
//   Env: GITHUB_TOKEN (permissão contents: write).
// - releaseServer: instaladores e manifesto no serviço de releases
//   próprio; o manifesto vai por último e é ele que publica a versão.
//   Env: ALCY_RELEASES_TOKEN.
// - manifest: gera o latest.json em target/release/bundle/ apontando para a
//   mesma pasta do manifesto; os arquivos são enviados à hospedagem por você.
//
// Uso (após `pnpm release:build` com TAURI_SIGNING_PRIVATE_KEY definido):
//   pnpm release:publish [--notes-file NOTAS.md] [--dry-run] [--bundle-dir <pasta>]

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
  const args = { dryRun: false, notesFile: null, bundleDir: join(ROOT, 'target', 'release', 'bundle') }
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

/** Instalador + assinatura de cada formato atualizável encontrado no bundle. */
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
  return artifacts
}

/** Manifesto do updater com as plataformas deste build somadas às já publicadas. */
function buildManifest({ version, previous, notesFile, artifacts, urlFor }) {
  const notes = notesFile ? readFileSync(notesFile, 'utf8').trim() : previous?.notes ?? `Alcy ${version}`
  const manifest = {
    version,
    notes,
    pub_date: previous?.pub_date ?? new Date().toISOString(),
    platforms: { ...(previous?.version === version ? previous.platforms : {}) },
  }
  for (const artifact of artifacts) {
    const entry = { url: urlFor(artifact.name), signature: readFileSync(artifact.signaturePath, 'utf8').trim() }
    for (const platform of artifact.platforms) manifest.platforms[platform] = entry
  }
  return manifest
}

function releaseRef() {
  return process.env.RELEASE_REF?.trim() || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
}

/** Cliente HTTP mínimo: falha com mensagem clara e, em dry-run, não escreve nada. */
function createHttp({ headers, dryRun, schemeHint }) {
  async function request(method, url, { body, json, allow404 = false, extraHeaders = {} } = {}) {
    const allHeaders = { ...headers, ...extraHeaders }
    if (json !== undefined) allHeaders['Content-Type'] = 'application/json'
    let response
    try {
      response = await fetch(url, { method, headers: allHeaders, body: json !== undefined ? JSON.stringify(json) : body })
    } catch (error) {
      const cause = error.cause ?? error
      // TLS falando com um servidor que responde HTTP puro nessa porta.
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

async function publishGitlab({ source, version, tag, artifacts, args }) {
  const projectUrl = new URL(source.url)
  const gitlabUrl = (process.env.GITLAB_URL?.trim() || projectUrl.origin).replace(/\/+$/, '')
  const projectPath = process.env.GITLAB_PROJECT?.trim() || projectUrl.pathname.replace(/^\/+|\/+$/g, '')
  const apiBase = `${gitlabUrl}/api/v4`
  const http = createHttp({
    headers: { 'PRIVATE-TOKEN': requiredEnv('GITLAB_TOKEN') },
    dryRun: args.dryRun,
    schemeHint: `use http:// em ALCY_UPDATE_URL ou em GITLAB_URL.`,
  })

  const project = await http.get(`${apiBase}/projects/${encodeURIComponent(projectPath)}`)
  const packageBase = `${apiBase}/projects/${project.id}/packages/generic/${PACKAGE_NAME}/${version}`
  const packageUrl = (file) => `${packageBase}/${encodeURIComponent(file)}`
  console.log(`GitLab: projeto ${project.path_with_namespace} (id ${project.id}), versão ${version}`)

  // 1. Instaladores (as assinaturas vão dentro do manifesto, não como arquivos).
  for (const artifact of artifacts) {
    console.log(`Enviando ${artifact.name}…`)
    await http.write('PUT', packageUrl(artifact.name), { body: readFileSync(artifact.path) })
  }

  // 2. Manifesto, mesclado com as plataformas já publicadas nesta versão.
  const existing = await http.get(packageUrl(MANIFEST_NAME), { allow404: true })
  const previous = typeof existing === 'string' ? JSON.parse(existing) : existing
  const manifest = buildManifest({ version, previous, notesFile: args.notesFile, artifacts, urlFor: packageUrl })
  console.log(`Enviando ${MANIFEST_NAME} (${Object.keys(manifest.platforms).join(', ')})…`)
  await http.write('PUT', packageUrl(MANIFEST_NAME), { body: JSON.stringify(manifest, null, 2) })

  // 3. Release e asset links.
  const releaseUrl = `${apiBase}/projects/${project.id}/releases/${encodeURIComponent(tag)}`
  const release = await http.get(releaseUrl, { allow404: true })
  if (!release) {
    const ref = releaseRef()
    console.log(`Criando a release ${tag} a partir de ${ref}…`)
    await http.write('POST', `${apiBase}/projects/${project.id}/releases`, {
      json: { tag_name: tag, ref, name: `Alcy ${version}`, description: manifest.notes },
    })
  } else if (args.notesFile) {
    await http.write('PUT', releaseUrl, { json: { description: manifest.notes } })
  }

  const existingLinks = release?.assets?.links?.map((link) => link.name) ?? []
  const links = [
    ...artifacts.map((artifact) => ({ name: artifact.name, url: packageUrl(artifact.name), link_type: 'package' })),
    { name: MANIFEST_NAME, url: packageUrl(MANIFEST_NAME), link_type: 'other' },
  ]
  for (const link of links) {
    if (existingLinks.includes(link.name)) continue
    await http.write('POST', `${releaseUrl}/assets/links`, { json: link })
  }

  console.log(`Release ${tag} publicada: ${project.web_url}/-/releases/${tag}`)
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

  // Manifesto já publicado nesta release (outra plataforma), para mesclar.
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

  // Assets com o mesmo nome são substituídos (a API não sobrescreve).
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

  // 1. Instaladores (as assinaturas vão dentro do manifesto, não como arquivos).
  for (const artifact of artifacts) {
    console.log(`Enviando ${artifact.name}…`)
    await http.write('PUT', fileUrl(artifact.name), {
      body: readFileSync(artifact.path),
      extraHeaders: { 'Content-Type': 'application/octet-stream' },
    })
  }

  // 2. Manifesto por último: só com ele a versão aparece para o app. Mesclado
  // com as plataformas já publicadas nesta versão.
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
  for (const artifact of artifacts) console.log(`  - ${artifact.path}`)
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
    case 'gitlab':
      return publishGitlab(context)
    case 'github':
      return publishGithub(context)
    case 'releaseServer':
      return publishReleaseServer(context)
    case 'manifest':
      return writeManifestLocally(context)
  }
}

await main()
