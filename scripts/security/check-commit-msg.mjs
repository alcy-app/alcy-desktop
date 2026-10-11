#!/usr/bin/env node
// Gatilho de revisão humana: commits que alteram arquivos protegidos (ver
// PROTECTED_PATHS em policy.mjs) precisam do trailer `Security-Review: <nome>`.
// Uso: `check-commit-msg.mjs <arquivo-da-mensagem>` no hook commit-msg, ou
// `check-commit-msg.mjs --range base..head` no pipeline.
import { readFileSync } from 'node:fs'

import { commitChanges, commitsInRange, rangeFromArgs, stagedChanges } from './git.mjs'
import { REVIEW_TRAILER, humanReviewer, isProtected, isVersionOnlyChange } from './policy.mjs'

function protectedChanges(changes) {
  return changes.files.filter(
    (file) => isProtected(file) && !isVersionOnlyChange(file, changes.before(file), changes.after(file)),
  )
}

const range = rangeFromArgs(process.argv)
const reports = range
  ? commitsInRange(range).map((sha) => {
      const changes = commitChanges(sha)
      return [sha.slice(0, 10), changes.message, protectedChanges(changes)]
    })
  : [['commit', readFileSync(process.argv[2], 'utf8'), protectedChanges(stagedChanges())]]

const failed = reports.filter(([, message, files]) => files.length > 0 && humanReviewer(message) === null)
if (failed.length > 0) {
  console.error('Mudança em arquivos de segurança sem revisão humana registrada:')
  for (const [where, , files] of failed) console.error(`  - [${where}] ${files.join(', ')}`)
  console.error(
    `Revise o diff desses arquivos e adicione ao final da mensagem a linha\n` +
      `  ${REVIEW_TRAILER}: <seu nome>\n` +
      `O trailer só pode ser escrito por uma pessoa; agentes são bloqueados de escrevê-lo.`,
  )
  process.exit(1)
}
