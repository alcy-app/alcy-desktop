const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Início do chunk `IEND`, percorrendo os chunks a partir da assinatura. */
function iendOffset(png: Uint8Array): number {
  if (!PNG_SIGNATURE.every((byte, index) => png[index] === byte)) throw new Error('não é um PNG')
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let offset = PNG_SIGNATURE.length
  while (offset + 8 <= png.length) {
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8))
    if (type === 'IEND') return offset
    offset += 12 + view.getUint32(offset)
  }
  throw new Error('PNG sem IEND')
}

/** Cópia do PNG com um chunk `iTXt` (texto UTF-8, sem compressão) antes do
 * `IEND` — lido de volta na importação pelo backend (ADR 0032). */
export function embedPngText(png: Uint8Array, keyword: string, text: string): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  // palavra-chave \0, compressão 0, método 0, idioma vazio \0, palavra traduzida vazia \0, texto
  const data = new Uint8Array([...encoder.encode(keyword), 0, 0, 0, 0, 0, ...encoder.encode(text)])
  const chunk = new Uint8Array(12 + data.length)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.length)
  chunk.set(encoder.encode('iTXt'), 4)
  chunk.set(data, 8)
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)))

  const insertAt = iendOffset(png)
  const out = new Uint8Array(png.length + chunk.length)
  out.set(png.subarray(0, insertAt))
  out.set(chunk, insertAt)
  out.set(png.subarray(insertAt), insertAt + chunk.length)
  return out
}
