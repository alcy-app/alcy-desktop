#!/usr/bin/env node
// Bloqueia commits com arquivos sensíveis (.env, chaves, certificados) ou com
// segredos nas linhas adicionadas. Sem argumentos verifica o índice (hook
// pre-commit); com `--range base..head` verifica cada commit (pipeline).
import { commitChanges, commitsInRange, rangeFromArgs, stagedChanges } from './git.mjs'
import { SECRET_ALLOW_MARKER, findSecrets, isSensitiveFile } from './policy.mjs'

const SKIPPED_FILES = /(^|\/)(pnpm-lock\.yaml|Cargo\.lock)$/

function inspect(changes) {
  const problems = []
  for (const file of changes.files) {
    if (isSensitiveFile(file) && changes.after(file) !== null) {
      problems.push(`${file}: arquivo sensível não pode ser versionado.`)
    }
  }
  for (const { file, text } of changes.addedLines()) {
    if (SKIPPED_FILES.test(file)) continue
    for (const label of findSecrets(text)) problems.push(`${file}: possível ${label} em linha adicionada.`)
  }
  return problems
}

const range = rangeFromArgs(process.argv)
const reports = range
  ? commitsInRange(range).map((sha) => [sha.slice(0, 10), inspect(commitChanges(sha))])
  : [['índice', inspect(stagedChanges())]]

const failed = reports.filter(([, problems]) => problems.length > 0)
if (failed.length > 0) {
  console.error('Segredos ou arquivos sensíveis encontrados:')
  for (const [where, problems] of failed) {
    for (const problem of problems) console.error(`  - [${where}] ${problem}`)
  }
  console.error(
    `Remova o segredo (e revogue-o se já saiu da máquina). Para fixture de teste com valor falso, ` +
      `marque a linha com "${SECRET_ALLOW_MARKER}".`,
  )
  process.exit(1)
}
