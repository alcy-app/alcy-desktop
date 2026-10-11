use thiserror::Error;

/// Como o Alcy chega à rede: direto, pelo proxy do sistema ou por um proxy
/// escolhido por script de configuração automática (PAC).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ProxySettings {
    /// Conexão direta, ignorando qualquer proxy configurado no sistema.
    #[default]
    Disabled,
    /// Usa o proxy configurado no sistema operacional.
    System,
    /// Baixa o script PAC de `url` e o consulta a cada destino.
    Pac { url: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ProxySettingsError {
    #[error("a URL do script de configuração automática não pode ser vazia")]
    EmptyPacUrl,
    #[error("a URL do script de configuração automática deve começar com http:// ou https://")]
    InvalidPacUrl,
}

impl ProxySettings {
    /// Cria a configuração PAC normalizando (trim) e validando a URL.
    pub fn pac(url: impl AsRef<str>) -> Result<Self, ProxySettingsError> {
        let url = url.as_ref().trim();
        if url.is_empty() {
            return Err(ProxySettingsError::EmptyPacUrl);
        }
        let lower = url.to_ascii_lowercase();
        let has_host = ["http://", "https://"]
            .iter()
            .any(|scheme| lower.starts_with(scheme) && lower.len() > scheme.len());
        if !has_host {
            return Err(ProxySettingsError::InvalidPacUrl);
        }
        Ok(Self::Pac {
            url: url.to_string(),
        })
    }

    pub fn is_enabled(&self) -> bool {
        !matches!(self, Self::Disabled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_disabled() {
        assert_eq!(ProxySettings::default(), ProxySettings::Disabled);
        assert!(!ProxySettings::default().is_enabled());
    }

    #[test]
    fn pac_trims_and_accepts_http_and_https() {
        assert_eq!(
            ProxySettings::pac("  https://corp/proxy.pac ").unwrap(),
            ProxySettings::Pac {
                url: "https://corp/proxy.pac".into()
            }
        );
        assert!(ProxySettings::pac("HTTP://corp/wpad.dat").is_ok());
    }

    #[test]
    fn pac_rejects_empty_and_non_http_urls() {
        assert_eq!(
            ProxySettings::pac("  "),
            Err(ProxySettingsError::EmptyPacUrl)
        );
        assert_eq!(
            ProxySettings::pac("ftp://corp/proxy.pac"),
            Err(ProxySettingsError::InvalidPacUrl)
        );
        assert_eq!(
            ProxySettings::pac("https://"),
            Err(ProxySettingsError::InvalidPacUrl)
        );
    }
}
