import { describe, expect, it } from 'vitest'
import { FEATURE_FLAGS } from './feature-flags'

describe('FEATURE_FLAGS', () => {
  it('enables visual load test creation, import and execution', () => {
    expect(FEATURE_FLAGS.loadTesting).toBe(true)
  })
})
