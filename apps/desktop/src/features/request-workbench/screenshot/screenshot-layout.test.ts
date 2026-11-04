import { describe, expect, it } from 'vitest'
import type { ScreenshotCodeBlock, ScreenshotContent } from './screenshot-content'
import { MAX_SCREENSHOT_HEIGHT, layoutScreenshot, type DrawOp, type MeasureText, type ScreenshotLayoutLabels } from './screenshot-layout'
import type { ScreenshotOptions } from './screenshot-options'

/** Fake monospaced font: each character measures 60% of the font size. */
const measure: MeasureText = (text, font) => text.length * font.size * 0.6

const labels: ScreenshotLayoutLabels = {
  request: 'Requisição',
  response: 'Resposta',
  headers: 'Headers',
  body: 'Body',
  trailers: 'Trailers',
  environment: (name) => `Ambiente: ${name}`,
  capturedAt: (date) => `Capturado em ${date}`,
  moreLines: (count) => `… mais ${count} linhas`,
  truncated: 'Imagem cortada',
}

function codeBlock(lines: string[], omittedLines = 0): ScreenshotCodeBlock {
  return { kind: 'code', label: null, language: 'text', lines, omittedLines, note: null }
}

const content: ScreenshotContent = {
  header: { title: 'Criar usuário', environment: 'Homologação', capturedAt: '26/09/2026 14:32' },
  endpoint: { method: 'POST', url: 'https://api.test/users' },
  request: { headers: [{ name: 'Accept', value: 'application/json' }], body: [codeBlock(['{"name":"Ana"}'])] },
  response: {
    kind: 'success',
    status: { statusCode: 201, tone: 'success', graphql: null, duration: '42 ms', size: '1.5 KB' },
    headers: null,
    body: codeBlock(['{', '  "id": 1', '}']),
  },
}

type Options = Pick<ScreenshotOptions, 'layout' | 'width'>
const vertical: Options = { layout: 'vertical', width: 'standard' }

const texts = (ops: DrawOp[]) => ops.flatMap((op) => (op.kind === 'text' ? [op.text] : []))
const cards = (ops: DrawOp[]) => ops.filter((op): op is Extract<DrawOp, { kind: 'rect' }> => op.kind === 'rect' && op.fill === 'surface')
const codeText = (op: DrawOp) => (op.kind === 'code' ? op.spans.map((span) => span.text).join('') : '')

describe('layoutScreenshot', () => {
  it('numbers excerpt lines from their position in the response and draws their own colors', () => {
    const body: ScreenshotCodeBlock = {
      ...codeBlock(['"a": 1', '"b": 2']),
      firstLineNumber: 98,
      spans: [[{ text: '"a": 1', tone: 'key' }], [{ text: '"b": 2', tone: 'key' }]],
    }
    const layout = layoutScreenshot({ ...content, request: null, response: { kind: 'success', status: null, headers: null, body } }, vertical, measure, labels)
    const code = layout.ops.filter((op) => op.kind === 'code').map(codeText)
    expect(code).toEqual(['98', '"a": 1', '99', '"b": 2'])
    expect(layout.ops.some((op) => op.kind === 'code' && op.spans.some((span) => span.text === '"a": 1' && span.tone === 'key'))).toBe(true)
  })

  it('wraps a long RPC method and keeps gRPC status, trailers and metrics inside compact columns', () => {
    const rpc = `very.long.package.${'Service'.repeat(10)}/LotsOfReplies`
    const layout = layoutScreenshot({ ...content,
      endpoint: { method: 'gRPC', url: 'grpcs://api.test:8443', rpc },
      response: { kind: 'success', status: { statusCode: 16, grpc: { codeName: 'UNAUTHENTICATED', message: 'Access denied' },
        tone: 'error', graphql: null, duration: '999999 ms', size: '10.0 MB' }, headers: null,
        trailers: [{ name: 'x-id', value: '42' }], body: codeBlock(['{}']) },
    }, { layout: 'sideBySide', width: 'compact' }, measure, labels)
    const output = texts(layout.ops)
    expect(output).toContain('gRPC 16 UNAUTHENTICATED')
    expect(output).toContain('Access denied')
    expect(output).toContain('Trailers')
    expect(output.some((text) => text.startsWith('HTTP '))).toBe(false)
    expect(output.join('')).toContain(rpc)
    for (const op of layout.ops) {
      if (op.kind === 'text') expect(op.x + measure(op.text, op.font)).toBeLessThanOrEqual(layout.width - 32)
    }
  })
  it('usa a largura escolhida e mostra cabeçalho, URL e seções', () => {
    const layout = layoutScreenshot(content, vertical, measure, labels)

    expect(layout.width).toBe(1200)
    expect(layout.truncated).toBe(false)
    expect(texts(layout.ops)).toEqual(
      expect.arrayContaining(['Alcy', 'Criar usuário', 'POST', 'https://api.test/users', 'REQUISIÇÃO', 'RESPOSTA', 'HTTP 201', '42 ms  ·  1.5 KB']),
    )
    expect(texts(layout.ops).some((text) => text.includes('Ambiente: Homologação'))).toBe(true)
    // Endpoint, request and response form three stacked cards.
    const [endpoint, request, response] = cards(layout.ops)
    expect(request.y).toBeGreaterThan(endpoint.y + endpoint.height)
    expect(response.y).toBeGreaterThan(request.y + request.height)
    expect(layout.height).toBeGreaterThan(response.y + response.height)
  })

  it('põe requisição e resposta lado a lado, com a mesma altura', () => {
    const layout = layoutScreenshot(content, { layout: 'sideBySide', width: 'wide' }, measure, labels)

    const [, request, response] = cards(layout.ops)
    expect(layout.width).toBe(1600)
    expect(request.y).toBe(response.y)
    expect(request.height).toBe(response.height)
    expect(response.x).toBeGreaterThan(request.x + request.width)
  })

  it('omite o que não está no conteúdo', () => {
    const layout = layoutScreenshot({ ...content, header: null, request: null }, vertical, measure, labels)

    expect(texts(layout.ops)).not.toContain('Alcy')
    expect(texts(layout.ops)).not.toContain('REQUISIÇÃO')
    expect(cards(layout.ops)).toHaveLength(2)
  })

  it('quebra linhas longas de código na largura do cartão', () => {
    const longLine = 'x'.repeat(500)
    const layout = layoutScreenshot(
      { ...content, request: null, response: { kind: 'success', status: null, headers: null, body: codeBlock([longLine]) } },
      { layout: 'vertical', width: 'compact' },
      measure,
      labels,
    )

    const segments = layout.ops.filter((op) => op.kind === 'code' && codeText(op).startsWith('x'))
    expect(segments.length).toBeGreaterThan(1)
    expect(segments.map(codeText).join('')).toBe(longLine)
    for (const segment of segments) expect(segment.x + codeText(segment).length * 12 * 0.6).toBeLessThanOrEqual(800)
  })

  it('avisa quantas linhas foram cortadas', () => {
    const layout = layoutScreenshot(
      { ...content, response: { kind: 'success', status: null, headers: null, body: codeBlock(['a'], 5) } },
      vertical,
      measure,
      labels,
    )
    expect(texts(layout.ops)).toContain('… mais 5 linhas')
  })

  it('mostra a mensagem de erro no cartão da resposta', () => {
    const layout = layoutScreenshot({ ...content, response: { kind: 'error', message: 'Tempo esgotado' } }, vertical, measure, labels)
    expect(texts(layout.ops)).toContain('Tempo esgotado')
  })

  it('corta na altura máxima e avisa no rodapé', () => {
    const lines = Array.from({ length: 2_000 }, (_, index) => `linha ${index}`)
    const layout = layoutScreenshot(
      { ...content, response: { kind: 'success', status: null, headers: null, body: codeBlock(lines) } },
      vertical,
      measure,
      labels,
    )

    expect(layout.truncated).toBe(true)
    expect(layout.height).toBe(MAX_SCREENSHOT_HEIGHT)
    expect(texts(layout.ops)).toContain('Imagem cortada')
    for (const op of layout.ops) expect(op.y + op.height).toBeLessThanOrEqual(MAX_SCREENSHOT_HEIGHT)
  })
})
