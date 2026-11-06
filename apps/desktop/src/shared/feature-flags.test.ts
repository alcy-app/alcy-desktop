import { describe, expect, it } from 'vitest'
import { FEATURE_FLAGS } from './feature-flags'

describe('FEATURE_FLAGS', () => {
  it('keeps load testing on and OneDrive off in this build', () => {
    expect(FEATURE_FLAGS.loadTesting).toBe(true)
    expect(FEATURE_FLAGS.onedrive).toBe(false)
  })

  it('ships git in the workspace on in this build', () => {
    expect(FEATURE_FLAGS.localGit).toBe(true)
  })

  it('keeps workspace documents behind their flag, off in this build', () => {
    expect(FEATURE_FLAGS.documents).toBe(false)
  })

  it('keeps usage events on: they stay inert without an extension sink', () => {
    expect(FEATURE_FLAGS.usageEvents).toBe(true)
  })
})
