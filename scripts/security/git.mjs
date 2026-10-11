// Acesso ao git para os verificadores de segurança. Dois modos:
// - staged: o que está no índice (hooks pre-commit e commit-msg);
// - range:  cada commit de `base..head` (pipeline do GitLab).
import { execFileSync } from 'node:child_process'

export function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options })
}

function tryGit(args) {
  try {
    return git(args, { stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/** Conteúdo de `path` em `ref` (`:` = índice), ou `null` se não existir. */
export function blob(ref, path) {
  return tryGit(['show', `${ref}:${path}`])
}

export function stagedChanges() {
  const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMRD', '-z'])
    .split('\0')
    .filter(Boolean)
  return {
    files,
    before: (path) => blob('HEAD', path),
    after: (path) => blob('', path),
    addedLines: () => addedLines(git(['diff', '--cached', '--unified=0', '--no-color', '--no-ext-diff'])),
  }
}

export function commitChanges(sha) {
  const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', sha])
    .split('\0')
    .filter(Boolean)
  return {
    sha,
    message: git(['log', '-1', '--format=%B', sha]),
    files,
    before: (path) => blob(`${sha}^`, path),
    after: (path) => blob(sha, path),
    addedLines: () => addedLines(git(['show', '--format=', '--unified=0', '--no-color', '--no-ext-diff', sha])),
  }
}

/** Commits não-merge de `base..head`, do mais antigo ao mais novo. */
export function commitsInRange(range) {
  return git(['rev-list', '--reverse', '--no-merges', range]).split('\n').filter(Boolean)
}

/** Linhas adicionadas de um diff unificado, com o arquivo de origem. */
function addedLines(diff) {
  const lines = []
  let file = null
  let binary = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = null
      binary = false
    } else if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? null : line.replace(/^\+\+\+ b\//, '')
    } else if (line.startsWith('Binary files ')) {
      binary = true
    } else if (file && !binary && line.startsWith('+')) {
      lines.push({ file, text: line.slice(1) })
    }
  }
  return lines
}

export function rangeFromArgs(argv) {
  const index = argv.indexOf('--range')
  return index >= 0 ? argv[index + 1] : null
}
