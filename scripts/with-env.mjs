#!/usr/bin/env node
// Roda um comando com o `.env` da raiz carregado e a origem de atualizações
// validada (ver build-env.mjs). Uso: node scripts/with-env.mjs tauri dev

import { spawnSync } from 'node:child_process'

import { loadDotEnv, updateSourceFromEnv } from './build-env.mjs'

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error('uso: node scripts/with-env.mjs <comando> [argumentos]')
  process.exit(2)
}

loadDotEnv()
try {
  updateSourceFromEnv()
} catch (error) {
  console.error(`erro: ${error.message}`)
  process.exit(1)
}

// No Windows, os atalhos de node_modules/.bin são .cmd e precisam do shell;
// os argumentos dos scripts do package.json não têm espaços.
const result =
  process.platform === 'win32'
    ? spawnSync([command, ...args].join(' '), { stdio: 'inherit', shell: true })
    : spawnSync(command, args, { stdio: 'inherit' })
if (result.error) {
  console.error(`erro: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
