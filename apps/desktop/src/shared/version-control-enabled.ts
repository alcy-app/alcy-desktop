import { FEATURE_FLAGS } from './feature-flags'

/**
 * The versioning tab, its status indicator and the sync checks. A function,
 * not a constant, so it follows the flags as they are read (and as tests set
 * them).
 */
export function isVersionControlEnabled(): boolean {
  return FEATURE_FLAGS.localGit
}
