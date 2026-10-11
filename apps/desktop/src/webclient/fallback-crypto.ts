/**
 * PBKDF2-HMAC-SHA256 e decifragem AES-256-GCM em TypeScript puro, para quando
 * o navegador não expõe `crypto.subtle`: fora de contexto seguro, ou seja, um
 * webclient servido por `http://` num host da rede interna (ADR 0046).
 *
 * Só decifra; a cifra acontece no app (`ring`). Os testes conferem cada
 * primitiva contra o WebCrypto do Node.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
])

const INITIAL_STATE = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]

const rotr = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits))

/** Processa um bloco de 64 bytes (`words`, 16 palavras big-endian) sobre `state`. */
function compress(state: Uint32Array, words: Uint32Array, schedule: Uint32Array): void {
  for (let i = 0; i < 16; i++) schedule[i] = words[i]
  for (let i = 16; i < 64; i++) {
    const w15 = schedule[i - 15]
    const w2 = schedule[i - 2]
    const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
    const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
    schedule[i] = (schedule[i - 16] + s0 + schedule[i - 7] + s1) | 0
  }
  let a = state[0]
  let b = state[1]
  let c = state[2]
  let d = state[3]
  let e = state[4]
  let f = state[5]
  let g = state[6]
  let h = state[7]
  for (let i = 0; i < 64; i++) {
    const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
    const choice = (e & f) ^ (~e & g)
    const t1 = (h + s1 + choice + K[i] + schedule[i]) | 0
    const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
    const majority = (a & b) ^ (a & c) ^ (b & c)
    const t2 = (s0 + majority) | 0
    h = g
    g = f
    f = e
    e = (d + t1) | 0
    d = c
    c = b
    b = a
    a = (t1 + t2) | 0
  }
  state[0] = (state[0] + a) | 0
  state[1] = (state[1] + b) | 0
  state[2] = (state[2] + c) | 0
  state[3] = (state[3] + d) | 0
  state[4] = (state[4] + e) | 0
  state[5] = (state[5] + f) | 0
  state[6] = (state[6] + g) | 0
  state[7] = (state[7] + h) | 0
}

/** Estado SHA-256 depois de absorver `data` e o padding, como 8 palavras. */
function sha256State(data: Uint8Array, initial: ArrayLike<number> = INITIAL_STATE, prefixBytes = 0): Uint32Array {
  const state = Uint32Array.from(initial)
  const totalBits = (data.length + prefixBytes) * 8
  const paddedLength = Math.ceil((data.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 8, Math.floor(totalBits / 2 ** 32))
  view.setUint32(paddedLength - 4, totalBits >>> 0)
  const words = new Uint32Array(16)
  const schedule = new Uint32Array(64)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4)
    compress(state, words, schedule)
  }
  return state
}

function stateBytes(state: Uint32Array): Uint8Array {
  const bytes = new Uint8Array(32)
  const view = new DataView(bytes.buffer)
  state.forEach((word, index) => view.setUint32(index * 4, word))
  return bytes
}

export function sha256(data: Uint8Array): Uint8Array {
  return stateBytes(sha256State(data))
}

/** Estados após absorver `key ^ ipad` e `key ^ opad` (um bloco cada). */
function hmacStates(key: Uint8Array): { inner: Uint32Array; outer: Uint32Array } {
  const block = new Uint8Array(64)
  block.set(key.length > 64 ? sha256(key) : key)
  const absorb = (pad: number) => {
    const state = Uint32Array.from(INITIAL_STATE)
    const view = new DataView(block.map((byte) => byte ^ pad).buffer)
    const words = new Uint32Array(16)
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(i * 4)
    compress(state, words, new Uint32Array(64))
    return state
  }
  return { inner: absorb(0x36), outer: absorb(0x5c) }
}

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const { inner, outer } = hmacStates(key)
  const innerDigest = stateBytes(sha256State(message, inner, 64))
  return stateBytes(sha256State(innerDigest, outer, 64))
}

/**
 * PBKDF2-HMAC-SHA256. Cada iteração reaproveita os estados do HMAC e um
 * bloco de 32 bytes já com padding: são duas compressões por iteração.
 */
export function pbkdf2Sha256(password: Uint8Array, salt: Uint8Array, iterations: number, length: number): Uint8Array {
  const { inner, outer } = hmacStates(password)
  const output = new Uint8Array(length)
  const words = new Uint32Array(16)
  const schedule = new Uint32Array(64)
  const state = new Uint32Array(8)
  const hashOf = (base: Uint32Array, digest: Uint32Array) => {
    for (let i = 0; i < 8; i++) words[i] = digest[i]
    words[8] = 0x80000000
    for (let i = 9; i < 15; i++) words[i] = 0
    words[15] = (64 + 32) * 8
    state.set(base)
    compress(state, words, schedule)
    return state
  }

  for (let blockIndex = 1, offset = 0; offset < length; blockIndex++, offset += 32) {
    const first = new Uint8Array(salt.length + 4)
    first.set(salt)
    new DataView(first.buffer).setUint32(salt.length, blockIndex)
    let u = Uint32Array.from(sha256State(first, inner, 64))
    u = Uint32Array.from(hashOf(outer, u))
    const accumulated = Uint32Array.from(u)
    for (let i = 1; i < iterations; i++) {
      u = Uint32Array.from(hashOf(inner, u))
      u = Uint32Array.from(hashOf(outer, u))
      for (let j = 0; j < 8; j++) accumulated[j] ^= u[j]
    }
    output.set(stateBytes(accumulated).subarray(0, Math.min(32, length - offset)), offset)
  }
  return output
}

const SBOX = (() => {
  const box = new Uint8Array(256)
  let p = 1
  let q = 1
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0)
    q ^= q << 1
    q ^= q << 2
    q ^= q << 4
    q &= 0xff
    if (q & 0x80) q ^= 0x09
    const rotated = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4))
    box[p] = (rotated ^ 0x63) & 0xff
  } while (p !== 1)
  box[0] = 0x63
  return box
})()

const xtime = (value: number) => ((value << 1) ^ (value & 0x80 ? 0x1b : 0)) & 0xff

function expandKey(key: Uint8Array): Uint8Array {
  const rounds = 14
  const expanded = new Uint8Array(16 * (rounds + 1))
  expanded.set(key)
  let rcon = 1
  for (let i = 32; i < expanded.length; i += 4) {
    let t0 = expanded[i - 4]
    let t1 = expanded[i - 3]
    let t2 = expanded[i - 2]
    let t3 = expanded[i - 1]
    if (i % 32 === 0) {
      ;[t0, t1, t2, t3] = [SBOX[t1] ^ rcon, SBOX[t2], SBOX[t3], SBOX[t0]]
      rcon = xtime(rcon)
    } else if (i % 32 === 16) {
      ;[t0, t1, t2, t3] = [SBOX[t0], SBOX[t1], SBOX[t2], SBOX[t3]]
    }
    expanded[i] = expanded[i - 32] ^ t0
    expanded[i + 1] = expanded[i - 31] ^ t1
    expanded[i + 2] = expanded[i - 30] ^ t2
    expanded[i + 3] = expanded[i - 29] ^ t3
  }
  return expanded
}

function encryptBlock(roundKeys: Uint8Array, input: Uint8Array): Uint8Array {
  const s = input.slice()
  const addRoundKey = (round: number) => {
    for (let i = 0; i < 16; i++) s[i] ^= roundKeys[round * 16 + i]
  }
  addRoundKey(0)
  for (let round = 1; round <= 14; round++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]]
    // ShiftRows (estado em colunas: índice = coluna * 4 + linha)
    const shifted = s.slice()
    for (let column = 0; column < 4; column++) {
      for (let row = 1; row < 4; row++) shifted[column * 4 + row] = s[((column + row) % 4) * 4 + row]
    }
    s.set(shifted)
    if (round !== 14) {
      for (let column = 0; column < 4; column++) {
        const offset = column * 4
        const [a0, a1, a2, a3] = [s[offset], s[offset + 1], s[offset + 2], s[offset + 3]]
        const all = a0 ^ a1 ^ a2 ^ a3
        s[offset] ^= all ^ xtime(a0 ^ a1)
        s[offset + 1] ^= all ^ xtime(a1 ^ a2)
        s[offset + 2] ^= all ^ xtime(a2 ^ a3)
        s[offset + 3] ^= all ^ xtime(a3 ^ a0)
      }
    }
    addRoundKey(round)
  }
  return s
}

/** Multiplicação em GF(2^128) do GHASH (bit a bit; payloads são pequenos). */
function gfMultiply(x: Uint8Array, y: Uint8Array): Uint8Array {
  const z = new Uint8Array(16)
  const v = y.slice()
  for (let i = 0; i < 128; i++) {
    if (x[i >> 3] & (0x80 >> (i & 7))) {
      for (let j = 0; j < 16; j++) z[j] ^= v[j]
    }
    const lsb = v[15] & 1
    for (let j = 15; j > 0; j--) v[j] = (v[j] >>> 1) | ((v[j - 1] & 1) << 7)
    v[0] >>>= 1
    if (lsb) v[0] ^= 0xe1
  }
  return z
}

function ghash(h: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  let y: Uint8Array = new Uint8Array(16)
  for (let offset = 0; offset < ciphertext.length; offset += 16) {
    const block = new Uint8Array(16)
    block.set(ciphertext.subarray(offset, offset + 16))
    for (let i = 0; i < 16; i++) y[i] ^= block[i]
    y = gfMultiply(y, h)
  }
  const lengths = new Uint8Array(16)
  const bits = ciphertext.length * 8
  const view = new DataView(lengths.buffer)
  view.setUint32(8, Math.floor(bits / 2 ** 32))
  view.setUint32(12, bits >>> 0)
  for (let i = 0; i < 16; i++) y[i] ^= lengths[i]
  return gfMultiply(y, h)
}

export class AuthenticationFailed extends Error {
  constructor() {
    super('authentication tag mismatch')
  }
}

/** Decifra AES-256-GCM (nonce de 12 bytes, tag de 16 no fim, sem AAD). */
export function aesGcmDecrypt(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array): Uint8Array {
  if (key.length !== 32 || nonce.length !== 12 || sealed.length < 16) throw new AuthenticationFailed()
  const roundKeys = expandKey(key)
  const ciphertext = sealed.subarray(0, sealed.length - 16)
  const tag = sealed.subarray(sealed.length - 16)
  const h = encryptBlock(roundKeys, new Uint8Array(16))
  const counter = new Uint8Array(16)
  counter.set(nonce)
  counter[15] = 1
  const expectedTag = encryptBlock(roundKeys, counter)
  const hashed = ghash(h, ciphertext)
  let difference = 0
  for (let i = 0; i < 16; i++) difference |= (expectedTag[i] ^ hashed[i]) ^ tag[i]
  if (difference !== 0) throw new AuthenticationFailed()

  const plaintext = new Uint8Array(ciphertext.length)
  const view = new DataView(counter.buffer)
  for (let offset = 0; offset < ciphertext.length; offset += 16) {
    view.setUint32(12, (view.getUint32(12) + 1) >>> 0)
    const stream = encryptBlock(roundKeys, counter)
    const end = Math.min(16, ciphertext.length - offset)
    for (let i = 0; i < end; i++) plaintext[offset + i] = ciphertext[offset + i] ^ stream[i]
  }
  return plaintext
}
