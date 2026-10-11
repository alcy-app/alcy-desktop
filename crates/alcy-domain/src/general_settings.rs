use std::time::Duration;

use thiserror::Error;

/// Timeout padrão das chamadas (REST, GraphQL, schema e flows).
pub const DEFAULT_REQUEST_TIMEOUT_SECONDS: u32 = 60;
/// Maior timeout aceito; acima disso, o usuário desabilita o timeout.
pub const MAX_REQUEST_TIMEOUT_SECONDS: u32 = 3600;
/// Limite padrão do corpo de resposta baixado (REST, GraphQL e flows).
pub const DEFAULT_RESPONSE_SIZE_LIMIT_MB: u32 = 50;
/// Maior limite aceito; acima disso, o usuário desabilita o limite.
pub const MAX_RESPONSE_SIZE_LIMIT_MB: u32 = 4096;
/// Retenção padrão do histórico de execuções, que também é a maior aceita.
pub const DEFAULT_HISTORY_RETENTION_DAYS: u32 = 7;
pub const MAX_HISTORY_RETENTION_DAYS: u32 = 7;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RequestTimeoutError {
    #[error("o timeout deve ficar entre 1 e {MAX_REQUEST_TIMEOUT_SECONDS} segundos")]
    OutOfRange,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ResponseSizeLimitError {
    #[error("o limite de resposta deve ficar entre 1 e {MAX_RESPONSE_SIZE_LIMIT_MB} MB")]
    OutOfRange,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum HistoryRetentionError {
    #[error("a retenção do histórico deve ficar entre 0 e {MAX_HISTORY_RETENTION_DAYS} dias")]
    OutOfRange,
}

/// Por quantos dias o histórico de execuções (requisições, flows e runner) é
/// mantido. Zero desativa o histórico: nada novo é gravado e o que já existe
/// é podado.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HistoryRetention(u32);

impl HistoryRetention {
    pub fn days(days: u32) -> Result<Self, HistoryRetentionError> {
        if days <= MAX_HISTORY_RETENTION_DAYS {
            Ok(Self(days))
        } else {
            Err(HistoryRetentionError::OutOfRange)
        }
    }

    pub fn as_days(self) -> u32 {
        self.0
    }

    pub fn is_disabled(self) -> bool {
        self.0 == 0
    }

    /// Idade máxima de uma entrada; `Duration::ZERO` quando desativado.
    pub fn duration(self) -> Duration {
        Duration::from_secs(u64::from(self.0) * 24 * 60 * 60)
    }
}

impl Default for HistoryRetention {
    fn default() -> Self {
        Self(DEFAULT_HISTORY_RETENTION_DAYS)
    }
}

/// Até quantos bytes de corpo de resposta uma chamada baixa. Acima disso, o
/// download é interrompido com `ExecutionError::ResponseTooLarge`, em vez de
/// manter em memória um corpo arbitrariamente grande.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseSizeLimit {
    /// Baixa respostas de qualquer tamanho.
    Disabled,
    Megabytes(u32),
}

impl ResponseSizeLimit {
    pub fn megabytes(megabytes: u32) -> Result<Self, ResponseSizeLimitError> {
        if (1..=MAX_RESPONSE_SIZE_LIMIT_MB).contains(&megabytes) {
            Ok(Self::Megabytes(megabytes))
        } else {
            Err(ResponseSizeLimitError::OutOfRange)
        }
    }

    /// `None` quando desabilitado.
    pub fn bytes(self) -> Option<usize> {
        match self {
            Self::Disabled => None,
            Self::Megabytes(megabytes) => Some(megabytes as usize * 1024 * 1024),
        }
    }
}

impl Default for ResponseSizeLimit {
    fn default() -> Self {
        Self::Megabytes(DEFAULT_RESPONSE_SIZE_LIMIT_MB)
    }
}

/// Quanto tempo uma chamada pode levar, da conexão ao fim do corpo da
/// resposta, antes de falhar com timeout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestTimeout {
    /// A chamada espera indefinidamente (o usuário ainda pode cancelar).
    Disabled,
    Seconds(u32),
}

impl RequestTimeout {
    pub fn seconds(seconds: u32) -> Result<Self, RequestTimeoutError> {
        if (1..=MAX_REQUEST_TIMEOUT_SECONDS).contains(&seconds) {
            Ok(Self::Seconds(seconds))
        } else {
            Err(RequestTimeoutError::OutOfRange)
        }
    }

    /// `None` quando desabilitado.
    pub fn duration(self) -> Option<Duration> {
        match self {
            Self::Disabled => None,
            Self::Seconds(seconds) => Some(Duration::from_secs(u64::from(seconds))),
        }
    }
}

impl Default for RequestTimeout {
    fn default() -> Self {
        Self::Seconds(DEFAULT_REQUEST_TIMEOUT_SECONDS)
    }
}

/// Preferências gerais do app (aba "Geral" das configurações).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GeneralSettings {
    pub request_timeout: RequestTimeout,
    pub response_size_limit: ResponseSizeLimit,
    pub history_retention: HistoryRetention,
    /// Guarda o corpo e os headers das respostas no histórico. Desligado por
    /// padrão (instalação nova): o histórico guarda a requisição e só o
    /// resumo da resposta (status, tempo e tamanho). Quem atualiza de uma
    /// versão anterior continua com as respostas guardadas
    /// (`GeneralSettingsStore::ensure_first_run_defaults`).
    pub save_history_responses: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_sixty_seconds() {
        assert_eq!(
            GeneralSettings::default().request_timeout.duration(),
            Some(Duration::from_secs(60))
        );
    }

    #[test]
    fn accepts_only_seconds_within_the_range() {
        assert_eq!(RequestTimeout::seconds(1), Ok(RequestTimeout::Seconds(1)));
        assert_eq!(
            RequestTimeout::seconds(MAX_REQUEST_TIMEOUT_SECONDS),
            Ok(RequestTimeout::Seconds(MAX_REQUEST_TIMEOUT_SECONDS))
        );
        assert_eq!(
            RequestTimeout::seconds(0),
            Err(RequestTimeoutError::OutOfRange)
        );
        assert_eq!(
            RequestTimeout::seconds(MAX_REQUEST_TIMEOUT_SECONDS + 1),
            Err(RequestTimeoutError::OutOfRange)
        );
    }

    #[test]
    fn a_disabled_timeout_has_no_duration() {
        assert_eq!(RequestTimeout::Disabled.duration(), None);
    }

    #[test]
    fn defaults_to_a_fifty_megabyte_response_limit() {
        assert_eq!(
            GeneralSettings::default().response_size_limit.bytes(),
            Some(50 * 1024 * 1024)
        );
    }

    #[test]
    fn accepts_only_response_limits_within_the_range() {
        assert_eq!(
            ResponseSizeLimit::megabytes(1),
            Ok(ResponseSizeLimit::Megabytes(1))
        );
        assert_eq!(
            ResponseSizeLimit::megabytes(0),
            Err(ResponseSizeLimitError::OutOfRange)
        );
        assert_eq!(
            ResponseSizeLimit::megabytes(MAX_RESPONSE_SIZE_LIMIT_MB + 1),
            Err(ResponseSizeLimitError::OutOfRange)
        );
        assert_eq!(ResponseSizeLimit::Disabled.bytes(), None);
    }

    #[test]
    fn defaults_to_a_seven_day_history_retention() {
        let retention = GeneralSettings::default().history_retention;
        assert_eq!(retention.as_days(), 7);
        assert_eq!(retention.duration(), Duration::from_secs(7 * 24 * 60 * 60));
        assert!(!retention.is_disabled());
    }

    #[test]
    fn does_not_save_history_responses_by_default() {
        assert!(!GeneralSettings::default().save_history_responses);
    }

    #[test]
    fn accepts_history_retentions_from_zero_to_the_maximum() {
        let disabled = HistoryRetention::days(0).unwrap();
        assert!(disabled.is_disabled());
        assert_eq!(disabled.duration(), Duration::ZERO);
        assert_eq!(
            HistoryRetention::days(MAX_HISTORY_RETENTION_DAYS).map(HistoryRetention::as_days),
            Ok(MAX_HISTORY_RETENTION_DAYS)
        );
        assert_eq!(
            HistoryRetention::days(MAX_HISTORY_RETENTION_DAYS + 1),
            Err(HistoryRetentionError::OutOfRange)
        );
    }
}
