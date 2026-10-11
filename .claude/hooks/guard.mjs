#!/usr/bin/env node
// Hook PreToolUse dos agentes: aplica scripts/security/agent-guard.mjs.
// Em caso de erro interno, pede confirmação em vez de liberar a ação.
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function respond(result) {
  if (!result) return
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: result.decision,
        permissionDecisionReason: result.reason,
      },
    }),
  )
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => (raw += chunk))
process.stdin.on('end', async () => {
  try {
    const { decide } = await import(pathToFileURL(join(projectDir, 'scripts/security/agent-guard.mjs')).href)
    respond(decide(JSON.parse(raw), { projectDir }))
  } catch (error) {
    respond({ decision: 'ask', reason: `Guarda de segurança falhou (${error.message}); confirme manualmente.` })
  }
})
