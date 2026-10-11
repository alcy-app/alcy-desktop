import { describe, expect, it } from 'vitest'
import { FEATURE_FLAGS } from './feature-flags'

describe('FEATURE_FLAGS', () => {
  it('mantém a interface de testes de carga desabilitada até a entrega experimental', () => {
    expect(FEATURE_FLAGS.loadTesting).toBe(false)
  })
})
