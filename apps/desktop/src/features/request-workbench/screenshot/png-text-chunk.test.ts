import { describe, expect, it } from 'vitest'
import { crc32, embedPngText } from './png-text-chunk'

const encoder = new TextEncoder()

function chunk(type: string, data: Uint8Array = new Uint8Array()): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(encoder.encode(type), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

function png(...chunks: Uint8Array[]): Uint8Array {
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Tipos e dados dos chunks, com o CRC conferido. */
function readChunks(bytes: Uint8Array): { type: string; data: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunks = []
  let offset = 8
  while (offset < bytes.length) {
    const length = view.getUint32(offset)
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8))
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    expect(view.getUint32(offset + 8 + length)).toBe(crc32(bytes.subarray(offset + 4, offset + 8 + length)))
    chunks.push({ type, data })
    offset += 12 + length
  }
  return chunks
}

describe('embedPngText', () => {
  it('calcula o CRC-32 do PNG', () => {
    expect(crc32(encoder.encode('IEND'))).toBe(0xae426082)
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926)
  })

  it('insere um chunk iTXt antes do IEND sem mexer nos demais', () => {
    const original = png(chunk('IHDR', new Uint8Array(13)), chunk('IDAT', new Uint8Array([1, 2, 3])), chunk('IEND'))

    const result = embedPngText(original, 'alcy.collections', '{"nome":"ação"}')

    const chunks = readChunks(result)
    expect(chunks.map((item) => item.type)).toEqual(['IHDR', 'IDAT', 'iTXt', 'IEND'])
    const expected = new Uint8Array([...encoder.encode('alcy.collections'), 0, 0, 0, 0, 0, ...encoder.encode('{"nome":"ação"}')])
    expect(chunks[2].data).toEqual(expected)
    expect(Array.from(result.subarray(0, original.length - 12))).toEqual(Array.from(original.subarray(0, original.length - 12)))
  })

  it('recusa o que não é PNG', () => {
    expect(() => embedPngText(new Uint8Array([1, 2, 3]), 'k', 'v')).toThrow()
    expect(() => embedPngText(png(chunk('IHDR', new Uint8Array(13))), 'k', 'v')).toThrow()
  })
})
