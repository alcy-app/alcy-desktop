import { aesGcmDecrypt, AuthenticationFailed, pbkdf2Sha256 } from './fallback-crypto'
import type { SealedEnvelope } from './types'

export class WrongPasswordError extends Error {
  constructor() {
    super('wrong password')
  }
}

export class UnsupportedEnvelopeError extends Error {
  constructor() {
    super('unsupported envelope')
  }
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Decifra o snapshot com a senha. Usa o WebCrypto quando existe (contexto
 * seguro: `https://`, `localhost` ou arquivo local); senão, a implementação
 * de reserva, mais lenta.
 */
export async function openEnvelope(
  envelope: SealedEnvelope,
  password: string,
  subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null,
): Promise<string> {
  if (envelope.version !== 1 || envelope.kdf !== 'PBKDF2-SHA256') throw new UnsupportedEnvelopeError()
  const passwordBytes = new TextEncoder().encode(password)
  const salt = fromBase64(envelope.salt)
  const nonce = fromBase64(envelope.nonce)
  const ciphertext = fromBase64(envelope.ciphertext)

  if (subtle) {
    try {
      const base = await subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey'])
      const key = await subtle.deriveKey(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: envelope.iterations },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt'],
      )
      const plaintext = await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext)
      return new TextDecoder().decode(plaintext)
    } catch {
      throw new WrongPasswordError()
    }
  }

  // Sem WebCrypto, a derivação roda na thread principal; o `setTimeout`
  // deixa a tela de desbloqueio pintar o estado "abrindo" antes.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const key = pbkdf2Sha256(passwordBytes, salt, envelope.iterations, 32)
  try {
    return new TextDecoder().decode(aesGcmDecrypt(key, nonce, ciphertext))
  } catch (error) {
    if (error instanceof AuthenticationFailed) throw new WrongPasswordError()
    throw error
  }
}
