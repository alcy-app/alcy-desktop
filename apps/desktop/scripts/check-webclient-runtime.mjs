#!/usr/bin/env node
// Sensor: o runtime do webclient versionado em
// crates/alcy-webclient/runtime/alcy-webclient.html precisa ser o build atual
// de src/webclient (ADR 0046). Recompila num diretório temporário e compara.
// Para atualizar: `pnpm --filter desktop run build:webclient`.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const committed = join(desktopDir, '..', '..', 'crates', 'alcy-webclient', 'runtime', 'alcy-webclient.html')
const outDir = mkdtempSync(join(tmpdir(), 'alcy-webclient-'))

try {
  execFileSync(process.execPath, [join(desktopDir, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.webclient.config.ts', '--logLevel', 'error'], {
    cwd: desktopDir,
    env: { ...process.env, ALCY_WEBCLIENT_OUT_DIR: outDir },
    stdio: 'inherit',
  })
  const fresh = readFileSync(join(outDir, 'alcy-webclient.html'), 'utf8')
  const current = readFileSync(committed, 'utf8')
  if (fresh !== current) {
    console.error(
      'crates/alcy-webclient/runtime/alcy-webclient.html está desatualizado em relação a src/webclient.\n' +
        'Rode `pnpm --filter desktop run build:webclient` e versione o arquivo gerado.',
    )
    process.exit(1)
  }
  console.log('Runtime do webclient atualizado.')
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
