import { describe, expect, it } from 'vitest'
import { FEATURE_FLAGS } from './feature-flags'

describe('FEATURE_FLAGS', () => {
  it('keeps load testing and OneDrive off in this build', () => {
    expect(FEATURE_FLAGS.loadTesting).toBe(false)
    expect(FEATURE_FLAGS.onedrive).toBe(false)
  })
})
