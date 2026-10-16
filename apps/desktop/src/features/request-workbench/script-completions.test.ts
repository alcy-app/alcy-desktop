import { CompletionContext } from '@codemirror/autocomplete'
import type { CompletionResult } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { completionSource } from './script-completions'

function complete(text: string, phase: 'pre' | 'post', explicit = false): CompletionResult | null {
  const state = EditorState.create({ doc: text })
  return completionSource(phase)(new CompletionContext(state, text.length, explicit)) as CompletionResult | null
}

const labels = (result: CompletionResult | null) => result?.options.map((option) => option.label) ?? []

describe('completionSource', () => {
  it('sugere o objeto al e o require a partir da primeira letra', () => {
    expect(labels(complete('a', 'pre'))).toEqual(['al', 'require'])
  })

  it('não sugere nada sem texto digitado', () => {
    expect(complete('', 'pre')).toBeNull()
  })

  it('lista os membros de al, com response só no pós-resposta', () => {
    const runnerMembers = ['test', 'expect', 'iteration', 'iterationData', 'require']
    const scopes = ['environment', 'collection', 'folder', 'variables', 'runtime', 'info']
    expect(labels(complete('al.', 'pre'))).toEqual(['request', ...scopes.slice(0, 3), ...scopes.slice(3), 'console', ...runnerMembers])
    expect(labels(complete('al.', 'post'))).toEqual(['request', 'response', ...scopes.slice(0, 3), ...scopes.slice(3), 'console', ...runnerMembers])
  })

  it('completa get/set nos escopos de variáveis', () => {
    for (const scope of ['environment', 'collection', 'folder', 'variables', 'runtime']) {
      expect(labels(complete(`al.${scope}.`, 'pre'))).toEqual(['get', 'set', 'has', 'unset', 'clear', 'toObject', 'replaceIn'])
    }
  })

  it('completa membros aninhados e substitui só o trecho após o último ponto', () => {
    const result = complete('al.request.hea', 'pre')

    expect(result?.from).toBe('al.request.'.length)
    expect(labels(result)).toContain('headers')
    expect(labels(complete('al.request.headers.', 'pre'))).toEqual(['get', 'set', 'remove', 'has', 'toObject', 'setAll', 'removeAll'])
  })

  it('oferece os métodos de al.response apenas no pós-resposta', () => {
    expect(labels(complete('al.response.', 'post'))).toEqual(['grpc', 'status', 'time', 'statusText', 'size', 'url', 'body', 'headers', 'text', 'json'])
    expect(complete('al.response.', 'pre')).toBeNull()
  })

  it('completes gRPC message, metadata and status fields', () => {
    expect(labels(complete('al.request.grpc.', 'pre'))).toEqual(['service', 'method', 'message', 'metadata'])
    expect(labels(complete('al.request.grpc.metadata.', 'pre'))).toContain('set')
    expect(labels(complete('al.response.grpc.', 'post'))).toEqual(['code', 'codeName', 'message', 'trailers', 'messages'])
    expect(complete('al.response.grpc.', 'pre')).toBeNull()
  })

  it('não sugere nada para um caminho desconhecido', () => {
    expect(complete('foo.', 'pre')).toBeNull()
  })
})
