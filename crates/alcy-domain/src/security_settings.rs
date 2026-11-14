/// Preferências de segurança lidas pelo backend.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SecuritySettings {
    /// Envia ao controle de versão os valores de variáveis sensíveis (em
    /// texto claro). Desligado por padrão: o arquivo de ambientes vai ao
    /// remoto com esses valores vazios.
    pub sync_sensitive_values: bool,
    /// Lets a send read body files outside the workspace that this person
    /// did not pick (spec 0163). Off by default: a collection decides those
    /// paths, and it may come from anyone.
    pub allow_body_files_outside_workspace: bool,
}
