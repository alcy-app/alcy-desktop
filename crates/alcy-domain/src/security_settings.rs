/// Preferências de segurança lidas pelo backend.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SecuritySettings {
    /// Envia ao controle de versão os valores de variáveis sensíveis (em
    /// texto claro). Desligado por padrão: o arquivo de ambientes vai ao
    /// remoto com esses valores vazios.
    pub sync_sensitive_values: bool,
}
