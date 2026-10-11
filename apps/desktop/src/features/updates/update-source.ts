import type { UpdateSourceDto } from '../../bindings/update-types'

/** A origem pode ser consultada: existe e, se exigir conta (GitLab), há uma conectada. */
export function isSourceReady(source: UpdateSourceDto | null | undefined): boolean {
  if (!source) return false
  return !source.requiresAccount || source.accountId !== null
}
