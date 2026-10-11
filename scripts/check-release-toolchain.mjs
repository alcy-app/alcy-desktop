#!/usr/bin/env node
// Garante que o build de release usa exatamente o Node e o pnpm fixados no
// repositório. O compilador Rust é fixado por rust-toolchain.toml (o rustup
// aplica sozinho) e as dependências pelos lockfiles (--frozen-lockfile/--locked).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

const expectedNode = readFileSync(join(ROOT, '.node-version'), 'utf8').trim()
if (process.version !== `v${expectedNode}`) {
  failures.push(`Node ${process.version} em uso; o release exige v${expectedNode} (.node-version).`)
}

const packageManager = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).packageManager
const expectedPnpm = packageManager?.replace(/^pnpm@/, '')
const userAgent = process.env.npm_config_user_agent ?? ''
if (!userAgent.startsWith(`pnpm/${expectedPnpm} `)) {
  failures.push(`pnpm em uso: "${userAgent.split(' ')[0] || 'desconhecido'}"; o release exige pnpm/${expectedPnpm} (packageManager).`)
}

if (failures.length > 0) {
  console.error('Toolchain do release diferente da fixada no repositório:')
  for (const message of failures) console.error(`  - ${message}`)
  process.exit(1)
}
