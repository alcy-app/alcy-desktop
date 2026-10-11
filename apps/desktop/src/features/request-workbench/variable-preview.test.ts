import { describe, expect, it } from 'vitest'
import type { EnvironmentVariableDto } from '../../bindings/list-environments'
import { MAX_PREVIEW_CHARS, variablePreviewFor } from './variable-preview'

const VARIABLES: EnvironmentVariableDto[] = [
  { name: 'token', value: 'abc123', sensitive: false },
  { name: 'secret', value: 's3cr3t', sensitive: true },
  { name: 'blank', value: '', sensitive: false },
  { name: 'long', value: 'x'.repeat(MAX_PREVIEW_CHARS + 10), sensitive: false },
]

describe('variablePreviewFor', () => {
  it('distingue definida, sensível, oculta e indefinida', () => {
    expect(variablePreviewFor('token', VARIABLES).state).toBe('defined')
    expect(variablePreviewFor('secret', VARIABLES).state).toBe('sensitive')
    expect(variablePreviewFor('token', VARIABLES, { hideValue: true }).state).toBe('hidden')
    expect(variablePreviewFor('nope', VARIABLES).state).toBe('undefined')
  })

  it('só expõe o valor de uma variável definida e não sensível', () => {
    expect(variablePreviewFor('token', VARIABLES).value).toBe('abc123')
    expect(variablePreviewFor('secret', VARIABLES).value).toBeNull()
    expect(variablePreviewFor('token', VARIABLES, { hideValue: true }).value).toBeNull()
  })

  it('corta valores longos', () => {
    const preview = variablePreviewFor('long', VARIABLES)
    expect(preview.truncated).toBe(true)
    expect(preview.value).toHaveLength(MAX_PREVIEW_CHARS)
  })
})
