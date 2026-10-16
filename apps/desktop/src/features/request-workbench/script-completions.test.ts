import { CompletionContext } from '@codemirror/autocomplete'
import type { CompletionResult } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { completionSource } from './script-completions'

/** `|` marks the cursor; without it the cursor is at the end. */
function complete(text: string, phase: 'pre' | 'post', explicit = false): CompletionResult | null {
  const cursor = text.includes('|') ? text.indexOf('|') : text.length
  const state = EditorState.create({ doc: text.replace('|', '') })
  return completionSource(phase)(new CompletionContext(state, cursor, explicit)) as CompletionResult | null
}

const labels = (result: CompletionResult | null) => result?.options.map((option) => option.label) ?? []

describe('completionSource', () => {
  it('sugere o objeto al e o require a partir da primeira letra', () => {
    expect(labels(complete('a', 'pre'))).toEqual(['al', 'require'])
  })

  it('não sugere nada sem texto digitado', () => {
    expect(complete('', 'pre')).toBeNull()
  })

  it('offers al and require on an empty word when opened by the shortcut', () => {
    expect(labels(complete('', 'pre', true))).toEqual(['al', 'require'])
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

  it('lists the bundled modules inside require quotes', () => {
    const modules = ['lodash', 'crypto-js', 'moment', 'uuid', 'npm:']
    expect(labels(complete("const _ = require('", 'pre'))).toEqual(modules)
    expect(labels(complete("const _ = al.require(\"lo", 'pre'))).toEqual(modules)
    expect(complete("const _ = require('lo", 'pre')?.from).toBe("const _ = require('".length)
    expect(complete("x.require('", 'pre')).toBeNull()
  })

  it('lists the members of a variable bound to a bundled module', () => {
    expect(labels(complete("const _ = require('lodash')\n_.", 'pre'))).toContain('chunk')
    expect(labels(complete("const uuid = al.require('uuid')\nuuid.", 'post'))).toContain('v4')
    const result = complete("const CryptoJS = require('crypto-js')\nCryptoJS.SHA", 'pre')
    expect(result?.from).toBe("const CryptoJS = require('crypto-js')\nCryptoJS.".length)
    expect(labels(result)).toContain('SHA256')
  })

  it('follows nested namespaces, calls and return types', () => {
    const crypto = "const CryptoJS = require('crypto-js')\n"
    expect(labels(complete(`${crypto}CryptoJS.enc.`, 'pre'))).toContain('Base64')
    expect(labels(complete(`${crypto}CryptoJS.enc.Base64.`, 'pre'))).toEqual(['stringify', 'parse'])
    expect(labels(complete(`${crypto}CryptoJS.HmacSHA256(body, 'k').`, 'pre'))).toContain('toString')
    expect(labels(complete(`${crypto}CryptoJS.AES.encrypt('a', key).`, 'pre'))).toContain('ciphertext')

    const moment = "const moment = require('moment')\n"
    expect(labels(complete(`${moment}moment().`, 'pre'))).toContain('format')
    expect(labels(complete(`${moment}moment().add(1, 'day')\n  .startOf('day').`, 'pre'))).toContain('toISOString')
    expect(labels(complete(`${moment}moment.`, 'pre'))).toContain('duration')
    expect(labels(complete(`${moment}moment.duration(2, 'h').`, 'pre'))).toContain('humanize')
  })

  it('lists members of a module required inline', () => {
    expect(labels(complete("require('uuid').", 'pre'))).toContain('v4')
    expect(labels(complete("al.require('crypto-js').enc.", 'pre'))).toContain('Utf8')
  })

  it('offers the exports inside a destructuring require', () => {
    expect(labels(complete("const { | } = require('uuid')", 'pre', true))).toContain('v4')
    expect(labels(complete("const { v4, va| } = require('uuid')", 'pre'))).toContain('validate')
    expect(labels(complete("const { v4: | } = require('uuid')", 'pre', true))).not.toContain('v1')
  })

  it('suggests nothing for unknown members or npm packages', () => {
    expect(complete("const _ = require('lodash')\n_.chunk.", 'pre')).toBeNull()
    expect(complete("const dayjs = require('npm:dayjs@1.11.13')\ndayjs.", 'pre')).toBeNull()
    expect(complete("const moment = require('moment')\nmoment.format().", 'pre')).toBeNull()
  })

  it('keeps suggesting al members', () => {
    expect(labels(complete("const _ = require('lodash')\nal.environment.", 'pre'))).toContain('get')
  })
})
