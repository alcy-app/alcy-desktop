import { describe, expect, it } from 'vitest'
import { suggestBranchName, toBranchName } from './branch-name'

describe('toBranchName', () => {
  it('turns what was typed into a valid branch name', () => {
    expect(toBranchName('Teste login')).toBe('teste-login')
    expect(toBranchName('  Ação: nova versão!! ')).toBe('acao-nova-versao')
    expect(toBranchName('equipe//API/..ajustes')).toBe('equipe/api/ajustes')
    expect(toBranchName('-x-')).toBe('x')
    expect(toBranchName('release.lock')).toBe('release')
    expect(toBranchName('a@{1}~^:?*[\\b')).toBe('a-1-b')
    expect(toBranchName('...')).toBe('')
  })
})

describe('suggestBranchName', () => {
  const today = new Date(2026, 10, 6)

  it("uses the person's name and today's date", () => {
    expect(suggestBranchName('Ana Lima', [], today, 'rascunho')).toBe('ana-lima-2026-11-06')
    expect(suggestBranchName(null, [], today, 'rascunho')).toBe('rascunho-2026-11-06')
    expect(suggestBranchName('!!!', [], today, '')).toBe('branch-2026-11-06')
  })

  it('appends a number while the name is taken', () => {
    expect(suggestBranchName('Ana', ['ana-2026-11-06', 'ana-2026-11-06-2'], today, 'x')).toBe('ana-2026-11-06-3')
  })
})
