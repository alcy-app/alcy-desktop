//! Cifra do payload com a senha do export (ADR 0046).
//!
//! PBKDF2-HMAC-SHA256 deriva uma chave AES-256-GCM da senha; o navegador
//! refaz a derivação e decifra com WebCrypto (ou com a implementação de
//! reserva do runtime, fora de contexto seguro). O envelope carrega tudo o
//! que a decifragem precisa, menos a senha.

use std::num::NonZeroU32;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use ring::pbkdf2;
use ring::rand::{SecureRandom, SystemRandom};
use serde::Serialize;

use crate::WebclientError;

/// Recomendação atual da OWASP para PBKDF2-HMAC-SHA256.
pub const PBKDF2_ITERATIONS: u32 = 600_000;
pub const MIN_PASSWORD_CHARS: usize = 8;
const SALT_LEN: usize = 16;
const KEY_LEN: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedEnvelope {
    pub version: u32,
    pub kdf: &'static str,
    pub iterations: u32,
    pub salt: String,
    pub nonce: String,
    /// Cifrado seguido da tag de 16 bytes, como o WebCrypto espera.
    pub ciphertext: String,
}

pub fn validate_password(password: &str) -> Result<(), WebclientError> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(WebclientError::PasswordTooShort {
            minimum: MIN_PASSWORD_CHARS,
        });
    }
    Ok(())
}

pub fn seal(plaintext: &[u8], password: &str) -> Result<SealedEnvelope, WebclientError> {
    seal_with_iterations(plaintext, password, PBKDF2_ITERATIONS)
}

pub(crate) fn seal_with_iterations(
    plaintext: &[u8],
    password: &str,
    iterations: u32,
) -> Result<SealedEnvelope, WebclientError> {
    validate_password(password)?;
    let rounds = NonZeroU32::new(iterations).ok_or(WebclientError::Crypto)?;
    let random = SystemRandom::new();
    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    random.fill(&mut salt).map_err(|_| WebclientError::Crypto)?;
    random
        .fill(&mut nonce)
        .map_err(|_| WebclientError::Crypto)?;

    let key = derive_key(password, &salt, rounds)?;
    let mut data = plaintext.to_vec();
    key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut data)
        .map_err(|_| WebclientError::Crypto)?;

    Ok(SealedEnvelope {
        version: 1,
        kdf: "PBKDF2-SHA256",
        iterations,
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(data),
    })
}

fn derive_key(
    password: &str,
    salt: &[u8],
    rounds: NonZeroU32,
) -> Result<LessSafeKey, WebclientError> {
    let mut key = [0u8; KEY_LEN];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        rounds,
        salt,
        password.as_bytes(),
        &mut key,
    );
    let unbound = UnboundKey::new(&AES_256_GCM, &key).map_err(|_| WebclientError::Crypto)?;
    Ok(LessSafeKey::new(unbound))
}

/// Decifra um envelope; só os testes precisam (o app nunca reabre um export).
#[cfg(test)]
pub(crate) fn open(envelope: &SealedEnvelope, password: &str) -> Result<Vec<u8>, WebclientError> {
    let decode = |text: &str| STANDARD.decode(text).map_err(|_| WebclientError::Crypto);
    let salt = decode(&envelope.salt)?;
    let nonce: [u8; NONCE_LEN] = decode(&envelope.nonce)?
        .try_into()
        .map_err(|_| WebclientError::Crypto)?;
    let rounds = NonZeroU32::new(envelope.iterations).ok_or(WebclientError::Crypto)?;
    let key = derive_key(password, &salt, rounds)?;
    let mut data = decode(&envelope.ciphertext)?;
    let plaintext = key
        .open_in_place(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut data)
        .map_err(|_| WebclientError::Crypto)?;
    Ok(plaintext.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_with_the_right_password() {
        let envelope = seal_with_iterations(b"{\"ok\":true}", "correct horse", 1_000).unwrap();

        assert_eq!(open(&envelope, "correct horse").unwrap(), b"{\"ok\":true}");
        assert_eq!(envelope.kdf, "PBKDF2-SHA256");
        assert_eq!(envelope.iterations, 1_000);
    }

    /// Vetor cifrado com o WebCrypto (a mesma API do navegador); o teste do
    /// runtime (`apps/desktop/src/webclient/seal.test.ts`) decifra o mesmo.
    #[test]
    fn opens_an_envelope_sealed_by_webcrypto() {
        let envelope = SealedEnvelope {
            version: 1,
            kdf: "PBKDF2-SHA256",
            iterations: 1_000,
            salt: "AQIDBAUGBwgJCgsMDQ4PEA==".into(),
            nonce: "yMnKy8zNzs/Q0dLT".into(),
            ciphertext: "2T2PeruJIpNmUaj9f0TnUygp44h8Dglb++KNjP3DLGCX8nJkVph4zTUUZ5s2MdmENoEEHLw="
                .into(),
        };

        assert_eq!(
            open(&envelope, "correct horse battery").unwrap(),
            br#"{"vector":"alcy-webclient","ok":true}"#
        );
    }

    #[test]
    fn wrong_password_fails() {
        let envelope = seal_with_iterations(b"secret", "correct horse", 1_000).unwrap();

        assert_eq!(open(&envelope, "wrong horse"), Err(WebclientError::Crypto));
    }

    #[test]
    fn ciphertext_does_not_contain_the_plaintext() {
        let envelope = seal_with_iterations(b"plain-marker", "correct horse", 1_000).unwrap();

        assert!(!envelope.ciphertext.contains("plain-marker"));
        assert!(
            !envelope
                .ciphertext
                .contains(&STANDARD.encode("plain-marker"))
        );
    }

    #[test]
    fn rejects_short_passwords() {
        assert_eq!(
            seal(b"x", "1234567"),
            Err(WebclientError::PasswordTooShort { minimum: 8 })
        );
    }

    #[test]
    fn production_envelopes_use_the_recommended_iterations() {
        let envelope = seal(b"x", "correct horse").unwrap();

        assert_eq!(envelope.iterations, PBKDF2_ITERATIONS);
    }
}
