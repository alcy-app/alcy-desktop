import type { UpdateSourceDto } from '../../bindings/update-types'

/** The build has somewhere to look for updates. */
export function isSourceReady(source: UpdateSourceDto | null | undefined): boolean {
  return Boolean(source)
}
