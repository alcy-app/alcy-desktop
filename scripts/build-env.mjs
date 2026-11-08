// Variáveis de build do Alcy, lidas do `.env` da raiz pelos scripts do
// package.json (ver scripts/with-env.mjs). O que já está no ambiente (shell,
// CI) tem prioridade sobre o arquivo.
//
// Origem das atualizações (ADR 0051), embutida no binário por `option_env!`:
// - ALCY_UPDATE_PROVIDER: github, manifest, releaseServer ou none;
//   sem a variável, o build não tem atualizações pelo app.
// - ALCY_UPDATE_URL: `dono/repositorio` do GitHub, URL do manifesto ou URL base do serviço de releases.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const UPDATE_PROVIDERS = ['github', 'manifest', 'releaseServer']

/** Carrega o `.env` sem sobrescrever variáveis já definidas. */
export function loadDotEnv(path = join(ROOT, '.env')) {
  if (!existsSync(path)) return
  for (const [name, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    if (process.env[name] === undefined) process.env[name] = value
  }
}

/**
 * Origem das atualizações do build, ou `null` quando desativada. Lança um
 * erro legível se a configuração estiver incompleta ou inválida; o app
 * validaria de novo, mas só mostraria "sem origem" na aba.
 */
export function updateSourceFromEnv(env = process.env) {
  const provider = env.ALCY_UPDATE_PROVIDER?.trim()
  if (!provider || provider === 'none') return null
  if (!UPDATE_PROVIDERS.includes(provider)) {
    throw new Error(`ALCY_UPDATE_PROVIDER inválido: "${provider}". Use ${UPDATE_PROVIDERS.join(', ')} ou none.`)
  }
  const url = env.ALCY_UPDATE_URL?.trim()
  if (!url) throw new Error(`defina ALCY_UPDATE_URL para o provedor ${provider}.`)
  if (provider === 'github') {
    if (!/^(https?:\/\/github\.com\/)?[\w.-]+\/[\w.-]+\/?$/.test(url)) {
      throw new Error('ALCY_UPDATE_URL do GitHub deve ser dono/repositorio.')
    }
  } else if (!/^https?:\/\/[^/\s]+\S*$/i.test(url)) {
    throw new Error('ALCY_UPDATE_URL deve começar com http:// ou https:// e não ter espaços.')
  }
  return { provider, url }
}
