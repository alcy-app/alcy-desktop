//! Runner de coleções (spec 0073): executa em sequência as requisições de
//! uma coleção ou pasta, com iterações, delay e critérios de parada.

use thiserror::Error;

pub const MAX_RUN_ITERATIONS: u32 = 1000;
pub const MAX_RUN_DELAY_MS: u64 = 600_000;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CollectionRunOptionsError {
    #[error("o número de iterações deve estar entre 1 e {MAX_RUN_ITERATIONS}")]
    Iterations,
    #[error("o delay entre requisições deve estar entre 0 e {MAX_RUN_DELAY_MS} ms")]
    Delay,
}

/// Configuração de um run. Opções só de apresentação (ex.: desativar logs
/// no Console) ficam fora daqui.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CollectionRunOptions {
    iterations: u32,
    delay_ms: u64,
    /// Para o run na primeira requisição que não passar.
    pub stop_on_error: bool,
    /// Respostas HTTP 4xx/5xx contam como falha.
    pub http_errors_fail: bool,
    /// Devolve as variáveis gravadas pelos scripts para o ambiente ativo.
    pub keep_variable_values: bool,
    /// Reenvia, nas requisições seguintes, os cookies recebidos no run.
    pub share_cookies: bool,
    /// Guarda os corpos das respostas (limitados) para inspeção.
    pub persist_responses: bool,
    pub save_to_history: bool,
}

impl CollectionRunOptions {
    pub fn new(iterations: u32, delay_ms: u64) -> Result<Self, CollectionRunOptionsError> {
        if !(1..=MAX_RUN_ITERATIONS).contains(&iterations) {
            return Err(CollectionRunOptionsError::Iterations);
        }
        if delay_ms > MAX_RUN_DELAY_MS {
            return Err(CollectionRunOptionsError::Delay);
        }
        Ok(Self {
            iterations,
            delay_ms,
            stop_on_error: false,
            http_errors_fail: true,
            keep_variable_values: true,
            share_cookies: true,
            persist_responses: true,
            save_to_history: true,
        })
    }

    pub fn iterations(&self) -> u32 {
        self.iterations
    }

    pub fn delay_ms(&self) -> u64 {
        self.delay_ms
    }
}

/// Resultado de um `al.test` dentro de um passo do run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunTestResult {
    pub name: String,
    pub passed: bool,
    pub message: Option<String>,
}

/// Como terminou uma requisição do run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunStepOutcome {
    /// Resposta recebida, sem erro de script e com todos os testes ok.
    Passed,
    /// Resposta recebida, mas um teste falhou, o pós-script falhou ou o
    /// status HTTP é de erro (com `http_errors_fail`).
    Failed,
    /// A requisição não chegou a uma resposta (rede, timeout, pré-script,
    /// variável ausente, requisição não encontrada).
    Error,
    /// O run foi cancelado com esta requisição em voo.
    Cancelled,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_iterations_and_delay() {
        assert_eq!(
            CollectionRunOptions::new(0, 0),
            Err(CollectionRunOptionsError::Iterations)
        );
        assert_eq!(
            CollectionRunOptions::new(MAX_RUN_ITERATIONS + 1, 0),
            Err(CollectionRunOptionsError::Iterations)
        );
        assert_eq!(
            CollectionRunOptions::new(1, MAX_RUN_DELAY_MS + 1),
            Err(CollectionRunOptionsError::Delay)
        );

        let options = CollectionRunOptions::new(3, 250).unwrap();
        assert_eq!(options.iterations(), 3);
        assert_eq!(options.delay_ms(), 250);
    }
}
