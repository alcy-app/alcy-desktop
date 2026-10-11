use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ring::aead::{Aad, CHACHA20_POLY1305, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};
use thiserror::Error;

/// Tamanho da chave de ChaCha20-Poly1305.
pub(crate) const KEY_LEN: usize = 32;
const TAG_LEN: usize = 16;
const PREFIX: &str = "v1:";
/// Amarra o texto cifrado a este uso: o mesmo blob não decifra em outro
/// contexto que venha a usar a mesma chave.
const AAD: &[u8] = b"alcy:local-secret:v1";

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SecretError {
    #[error("chave de criptografia inválida")]
    InvalidKey,
    #[error("falha ao gerar dados aleatórios")]
    Random,
    #[error("falha ao cifrar valor")]
    Seal,
    #[error("valor cifrado em formato inválido")]
    Malformed,
    #[error("não foi possível decifrar o valor (chave diferente ou dado alterado)")]
    Undecryptable,
}

/// Cifra autenticada (ChaCha20-Poly1305, via `ring`) para valores pequenos
/// guardados em disco. Cada chamada a `encrypt` usa um nonce aleatório de 96
/// bits — seguro para o volume de valores que um usuário gera com uma chave.
/// O resultado é texto: `"v1:" + base64(nonce ‖ texto cifrado ‖ tag)`.
pub struct SecretCipher {
    key: LessSafeKey,
    rng: SystemRandom,
}

impl SecretCipher {
    pub fn from_key(bytes: &[u8]) -> Result<Self, SecretError> {
        if bytes.len() != KEY_LEN {
            return Err(SecretError::InvalidKey);
        }
        let key =
            UnboundKey::new(&CHACHA20_POLY1305, bytes).map_err(|_| SecretError::InvalidKey)?;
        Ok(Self {
            key: LessSafeKey::new(key),
            rng: SystemRandom::new(),
        })
    }

    pub fn generate_key() -> Result<[u8; KEY_LEN], SecretError> {
        let mut key = [0u8; KEY_LEN];
        SystemRandom::new()
            .fill(&mut key)
            .map_err(|_| SecretError::Random)?;
        Ok(key)
    }

    pub fn encrypt(&self, plaintext: &str) -> Result<String, SecretError> {
        let mut nonce = [0u8; NONCE_LEN];
        self.rng.fill(&mut nonce).map_err(|_| SecretError::Random)?;

        let mut sealed = Vec::with_capacity(NONCE_LEN + plaintext.len() + TAG_LEN);
        sealed.extend_from_slice(&nonce);
        sealed.extend_from_slice(plaintext.as_bytes());
        let tag = self
            .key
            .seal_in_place_separate_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(AAD),
                &mut sealed[NONCE_LEN..],
            )
            .map_err(|_| SecretError::Seal)?;
        sealed.extend_from_slice(tag.as_ref());

        Ok(format!("{PREFIX}{}", STANDARD.encode(sealed)))
    }

    pub fn decrypt(&self, sealed: &str) -> Result<String, SecretError> {
        let encoded = sealed.strip_prefix(PREFIX).ok_or(SecretError::Malformed)?;
        let mut blob = STANDARD
            .decode(encoded)
            .map_err(|_| SecretError::Malformed)?;
        if blob.len() < NONCE_LEN + TAG_LEN {
            return Err(SecretError::Malformed);
        }

        let (nonce, body) = blob.split_at_mut(NONCE_LEN);
        let nonce = Nonce::try_assume_unique_for_key(nonce).map_err(|_| SecretError::Malformed)?;
        let plaintext = self
            .key
            .open_in_place(nonce, Aad::from(AAD), body)
            .map_err(|_| SecretError::Undecryptable)?;

        String::from_utf8(plaintext.to_vec()).map_err(|_| SecretError::Malformed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cipher() -> SecretCipher {
        SecretCipher::from_key(&SecretCipher::generate_key().unwrap()).unwrap()
    }

    #[test]
    fn round_trips_a_value() {
        let cipher = cipher();

        let sealed = cipher.encrypt("s3cr3t ✓").unwrap();

        assert!(sealed.starts_with(PREFIX));
        assert!(!sealed.contains("s3cr3t"));
        assert_eq!(cipher.decrypt(&sealed).unwrap(), "s3cr3t ✓");
    }

    #[test]
    fn round_trips_an_empty_value() {
        let cipher = cipher();

        let sealed = cipher.encrypt("").unwrap();

        assert_eq!(cipher.decrypt(&sealed).unwrap(), "");
    }

    #[test]
    fn uses_a_fresh_nonce_per_call() {
        let cipher = cipher();

        assert_ne!(
            cipher.encrypt("same").unwrap(),
            cipher.encrypt("same").unwrap()
        );
    }

    #[test]
    fn rejects_a_tampered_value() {
        let cipher = cipher();
        let sealed = cipher.encrypt("token").unwrap();
        let mut blob = STANDARD.decode(&sealed[PREFIX.len()..]).unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 1;
        let tampered = format!("{PREFIX}{}", STANDARD.encode(blob));

        assert_eq!(cipher.decrypt(&tampered), Err(SecretError::Undecryptable));
    }

    #[test]
    fn rejects_a_value_sealed_with_another_key() {
        let sealed = cipher().encrypt("token").unwrap();

        assert_eq!(cipher().decrypt(&sealed), Err(SecretError::Undecryptable));
    }

    #[test]
    fn rejects_malformed_values() {
        let cipher = cipher();

        for value in ["", "token", "v1:", "v1:não-base64", "v1:AAAA"] {
            assert_eq!(
                cipher.decrypt(value),
                Err(SecretError::Malformed),
                "{value}"
            );
        }
    }

    #[test]
    fn rejects_keys_with_the_wrong_length() {
        assert!(matches!(
            SecretCipher::from_key(&[0u8; 16]),
            Err(SecretError::InvalidKey)
        ));
    }
}
