use thiserror::Error;

/// Uma linha de header HTTP editável pelo usuário.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderEntry {
    name: String,
    value: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum HeaderError {
    #[error("nome do header não pode ser vazio")]
    EmptyName,
    #[error("nome do header contém caracteres inválidos")]
    InvalidName,
    #[error("valor do header contém caracteres inválidos")]
    InvalidValue,
}

impl HeaderEntry {
    pub fn new(
        name: impl Into<String>,
        value: impl Into<String>,
        enabled: bool,
    ) -> Result<Self, HeaderError> {
        let name = name.into();
        let value = value.into();

        if name.trim().is_empty() {
            return Err(HeaderError::EmptyName);
        }
        if name.contains('\r') || name.contains('\n') {
            return Err(HeaderError::InvalidName);
        }
        if value.contains('\r') || value.contains('\n') {
            return Err(HeaderError::InvalidValue);
        }

        Ok(Self {
            name,
            value,
            enabled,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn value(&self) -> &str {
        &self.value
    }

    /// Valida a sintaxe HTTP para planos executáveis. A criação de entradas
    /// editáveis/persistidas mantém seu contrato, inclusive em workspaces antigos.
    pub fn validate_http(&self) -> Result<(), HeaderError> {
        if !self.name.bytes().all(is_header_name_byte) {
            return Err(HeaderError::InvalidName);
        }
        if !self
            .value
            .bytes()
            .all(|byte| byte == b'\t' || (byte >= b' ' && byte != 0x7f))
        {
            return Err(HeaderError::InvalidValue);
        }
        Ok(())
    }
}

/// Nome de campo HTTP: token ASCII (RFC 9110, seção 5.1).
fn is_header_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_valid_header() {
        let header = HeaderEntry::new("Authorization", "Bearer token", true).unwrap();

        assert_eq!(header.name(), "Authorization");
        assert_eq!(header.value(), "Bearer token");
        assert!(header.enabled);
    }

    #[test]
    fn rejects_an_empty_name() {
        assert_eq!(
            HeaderEntry::new("", "value", true),
            Err(HeaderError::EmptyName)
        );
        assert_eq!(
            HeaderEntry::new("   ", "value", true),
            Err(HeaderError::EmptyName)
        );
    }

    #[test]
    fn rejects_a_name_with_control_characters() {
        assert_eq!(
            HeaderEntry::new("X-Injected\r\nEvil: 1", "value", true),
            Err(HeaderError::InvalidName)
        );
    }

    #[test]
    fn rejects_a_value_with_control_characters() {
        assert_eq!(
            HeaderEntry::new("X-Header", "value\r\nEvil: 1", true),
            Err(HeaderError::InvalidValue)
        );
    }

    #[test]
    fn rejects_invalid_http_field_names_and_values_before_execution() {
        for name in ["Invalid Header", "X:Header", "X-ç", "X\tHeader"] {
            assert_eq!(
                HeaderEntry::new(name, "value", true)
                    .unwrap()
                    .validate_http(),
                Err(HeaderError::InvalidName)
            );
        }
        for value in ["value\0", "value\u{7f}", "value\u{1f}"] {
            assert_eq!(
                HeaderEntry::new("X-Header", value, true)
                    .unwrap()
                    .validate_http(),
                Err(HeaderError::InvalidValue)
            );
        }
        assert!(
            HeaderEntry::new("X-Header", "value\twith tab", true)
                .unwrap()
                .validate_http()
                .is_ok()
        );
    }
}
