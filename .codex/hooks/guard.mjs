#!/usr/bin/env node
// Codex PreToolUse adapter for the shared policy. Codex does not accept `ask`
// in this event, so actions that would need confirmation are denied.
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const fallbackProjectDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Same global-option prefix as `agent-guard.mjs`.
const GIT_COMMIT = /\bgit(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b/g

// Commits are left to Codex's native rules (`.codex/rules/default.rules`, which
// allow them) when they are the only part of the command that would need
// confirmation.
function onlyCommitNeedsConfirmation(event, decide, projectDir) {
  if (event.tool_name !== 'Bash') return false
  const command = String(event.tool_input?.command ?? '')
  if (!command.match(GIT_COMMIT)) return false
  const rest = command.replace(GIT_COMMIT, 'git status')
  return decide({ ...event, tool_input: { ...event.tool_input, command: rest } }, { projectDir }) === null
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  )
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => (raw += chunk))
process.stdin.on('end', async () => {
  try {
    const event = JSON.parse(raw)
    const projectDir = event.cwd ?? fallbackProjectDir
    const { decide } = await import(pathToFileURL(join(projectDir, 'scripts/security/agent-guard.mjs')).href)
    const result = decide(event, { projectDir })
    if (!result) return
    if (result.decision === 'ask') {
      if (onlyCommitNeedsConfirmation(event, decide, projectDir)) return
      deny(
        `${result.reason} O PreToolUse do Codex não consegue abrir uma confirmação; execute a ação manualmente.`,
      )
      return
    }
    deny(result.reason)
  } catch (error) {
    deny(`Guarda de segurança do Codex falhou (${error.message}); ação bloqueada por segurança.`)
  }
})
