import { describe, expect, it } from 'vitest'
import { aesGcmDecrypt, hmacSha256, pbkdf2Sha256, sha256 } from './fallback-crypto'
import { openEnvelope, WrongPasswordError } from './seal'
import type { SealedEnvelope } from './types'

const subtle = globalThis.crypto.subtle

/** Mesmo vetor de `crates/alcy-webclient/src/seal.rs` (`opens_an_envelope_sealed_by_webcrypto`). */
const VECTOR: SealedEnvelope = {
  version: 1,
  kdf: 'PBKDF2-SHA256',
  iterations: 1000,
  salt: 'AQIDBAUGBwgJCgsMDQ4PEA==',
  nonce: 'yMnKy8zNzs/Q0dLT',
  ciphertext: '2T2PeruJIpNmUaj9f0TnUygp44h8Dglb++KNjP3DLGCX8nJkVph4zTUUZ5s2MdmENoEEHLw=',
}
const VECTOR_PLAINTEXT = '{"vector":"alcy-webclient","ok":true}'

const bytes = (text: string) => new TextEncoder().encode(text)
const random = (length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length))
const hex = (data: ArrayBuffer | Uint8Array) =>
  Array.from(data instanceof Uint8Array ? data : new Uint8Array(data), (byte) => byte.toString(16).padStart(2, '0')).join('')

describe('openEnvelope', () => {
  it('opens the cross-language vector with WebCrypto', async () => {
    await expect(openEnvelope(VECTOR, 'correct horse battery', subtle)).resolves.toBe(VECTOR_PLAINTEXT)
  })

  it('opens the cross-language vector without WebCrypto', async () => {
    await expect(openEnvelope(VECTOR, 'correct horse battery', null)).resolves.toBe(VECTOR_PLAINTEXT)
  })

  it('reports a wrong password on both paths', async () => {
    await expect(openEnvelope(VECTOR, 'wrong horse battery', subtle)).rejects.toBeInstanceOf(WrongPasswordError)
    await expect(openEnvelope(VECTOR, 'wrong horse battery', null)).rejects.toBeInstanceOf(WrongPasswordError)
  })
})

describe('fallback crypto', () => {
  it('matches WebCrypto SHA-256 across block boundaries', async () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 200]) {
      const data = random(length)
      expect(hex(sha256(data))).toBe(hex(await subtle.digest('SHA-256', data)))
    }
  })

  it('matches WebCrypto HMAC-SHA256, including long keys', async () => {
    for (const keyLength of [5, 64, 100]) {
      const key = random(keyLength)
      const message = random(77)
      const imported = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      expect(hex(hmacSha256(key, message))).toBe(hex(await subtle.sign('HMAC', imported, message)))
    }
  })

  it('matches WebCrypto PBKDF2', async () => {
    const password = bytes('pässword')
    const salt = random(16)
    const base = await subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits'])
    const expected = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 2048 }, base, 256)
    expect(hex(pbkdf2Sha256(password, salt, 2048, 32))).toBe(hex(expected))
  })

  it('matches WebCrypto AES-256-GCM and rejects tampering', async () => {
    for (const length of [0, 1, 16, 33, 500]) {
      const keyBytes = random(32)
      const nonce = random(12)
      const plaintext = random(length)
      const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
      const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext))

      expect(hex(aesGcmDecrypt(keyBytes, nonce, sealed))).toBe(hex(plaintext))
      sealed[0] ^= 1
      expect(() => aesGcmDecrypt(keyBytes, nonce, sealed)).toThrow()
    }
  })
})
