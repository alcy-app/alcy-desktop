import { describe, expect, it, vi } from 'vitest'
import { formatOffMainThread } from './format-off-main-thread'

describe('formatOffMainThread', () => {
  it('formata JSON igual ao formatador síncrono (fallback sem Worker no ambiente de teste)', async () => {
    expect(await formatOffMainThread('{"a":1}', 'json')).toBe('{\n  "a": 1\n}')
  })

  it('devolve o texto original quando o JSON é inválido, sem lançar', async () => {
    const invalid = 'não é json'
    expect(await formatOffMainThread(invalid, 'json')).toBe(invalid)
  })

  it('com `partial`, indenta JSON truncado em vez de devolvê-lo bruto', async () => {
    expect(await formatOffMainThread('{"a":{"b":1},"c":[', 'json', { partial: true })).toBe('{\n  "a": {\n    "b": 1\n  },\n  "c": [')
  })

  it('formata XML igual ao formatador síncrono (fallback sem Worker no ambiente de teste)', async () => {
    const formatted = await formatOffMainThread('<a><b>x</b></a>', 'xml')
    expect(formatted).toContain('<a>')
    expect(formatted).toContain('<b>x</b>')
  })
})

describe('formatOffMainThread com canal', () => {
  it('mantém um pedido em execução e um na espera; o mais novo substitui o que esperava', async () => {
    const posted: { id: number; text: string }[] = []
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      postMessage(request: { id: number; text: string }) {
        posted.push(request)
      }
      respond(id: number, formatted: string) {
        this.onmessage?.({ data: { kind: 'format', id, formatted } } as MessageEvent)
      }
    }
    let instance: FakeWorker | null = null
    vi.stubGlobal(
      'Worker',
      class extends FakeWorker {
        constructor() {
          super()
          // eslint-disable-next-line @typescript-eslint/no-this-alias -- o teste responde pelo worker criado pelo módulo
          instance = this
        }
      },
    )
    vi.resetModules()
    const module = await import('./format-off-main-thread')
    const channel = module.createFormatChannel()

    const first = module.formatOffMainThread('v1', 'json', { channel })
    const second = module.formatOffMainThread('v2', 'json', { channel })
    const third = module.formatOffMainThread('v3', 'json', { channel })

    expect(await second).toBeNull()
    expect(posted.map((request) => request.text)).toEqual(['v1'])

    instance!.respond(posted[0].id, 'F1')
    expect(await first).toBe('F1')
    await vi.waitFor(() => expect(posted.map((request) => request.text)).toEqual(['v1', 'v3']))

    instance!.respond(posted[1].id, 'F3')
    expect(await third).toBe('F3')

    vi.unstubAllGlobals()
    vi.resetModules()
  })
})
