/**
 * A branch name git accepts, from whatever the person typed: lowercase, no
 * accents, anything outside `a-z 0-9 . _ / -` turned into `-`, no empty or
 * dotted path segments. Lowercase so "Teste" and "teste" are the same branch
 * for everyone sharing a folder.
 */
export function toBranchName(input: string): string {
  let name = input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/\.{2,}/g, '.')
  const clean = (value: string) => value
    .split('/')
    .map((part) => part.replace(/^[-.]+|[-.]+$/g, ''))
    .filter((part) => part !== '')
    .join('/')
  name = clean(name)
  while (name.endsWith('.lock')) name = clean(name.slice(0, -'.lock'.length))
  return name
}

function isoDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Suggested name for a new branch: the person's name and today's date
 * (`ana-lima-2026-11-06`), so two people's branches rarely collide by
 * accident; `fallback` when the git user is unknown. A number is appended
 * while the name is taken.
 */
export function suggestBranchName(person: string | null | undefined, existing: string[], today: Date, fallback: string): string {
  const prefix = toBranchName(person ?? '') || toBranchName(fallback) || 'branch'
  const base = `${prefix}-${isoDate(today)}`
  if (!existing.includes(base)) return base
  let index = 2
  while (existing.includes(`${base}-${index}`)) index += 1
  return `${base}-${index}`
}
