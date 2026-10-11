#!/usr/bin/env node
// Validates a `release/vX.Y.Z` branch before the release workflow builds it:
// the version in the branch name must match the app version, the CHANGELOG
// must have a dated section for it and the tag `vX.Y.Z` must not exist yet
// (a published version is never rebuilt over). Writes that CHANGELOG section
// as the release notes.
//
// Usage: node scripts/prepare-release.mjs <release/vX.Y.Z> [--notes-file <path>] [--skip-tag-check]

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8')
}

function parseArgs(argv) {
  const args = { branch: null, notesFile: null, tagCheck: true }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--notes-file') args.notesFile = argv[++index]
    else if (arg === '--skip-tag-check') args.tagCheck = false
    else if (!args.branch) args.branch = arg
    else fail(`unknown argument: ${arg}`)
  }
  if (!args.branch) fail('usage: prepare-release.mjs <release/vX.Y.Z> [--notes-file <path>] [--skip-tag-check]')
  return args
}

/** Body of the `## [X.Y.Z] - YYYY-MM-DD` section, without the heading. */
function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const escaped = version.replace(/\./g, '\\.')
  const start = lines.findIndex((line) => new RegExp(`^## \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`).test(line))
  if (start === -1) return null
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line))
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim()
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const version = args.branch.replace(/^refs\/heads\//, '').match(/^release\/v(\d+\.\d+\.\d+)$/)?.[1]
  if (!version) fail(`"${args.branch}" is not a release branch (release/vX.Y.Z).`)

  const tauriVersion = JSON.parse(read('src-tauri/tauri.conf.json')).version
  if (tauriVersion !== version) fail(`src-tauri/tauri.conf.json has version ${tauriVersion}, the branch asks for ${version}.`)
  const cargoVersion = read('src-tauri/Cargo.toml').match(/^version\s*=\s*"([^"]+)"/m)?.[1]
  if (cargoVersion !== version) fail(`src-tauri/Cargo.toml has version ${cargoVersion}, the branch asks for ${version}.`)

  const notes = changelogSection(read('CHANGELOG.md'), version)
  if (!notes) fail(`CHANGELOG.md needs a non-empty "## [${version}] - YYYY-MM-DD" section.`)

  if (args.tagCheck) {
    const tag = execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/v${version}`], { cwd: ROOT, encoding: 'utf8' })
    if (tag.trim()) fail(`tag v${version} already exists: bump the version instead of republishing it.`)
  }

  if (args.notesFile) writeFileSync(args.notesFile, `${notes}\n`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`)
  console.log(`Release ${version} is ready to build.`)
}

main()
