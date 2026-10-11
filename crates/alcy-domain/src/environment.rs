use std::collections::HashSet;

use thiserror::Error;

/// Uma variável de ambiente, usada para interpolar `{{nome}}` em campos da
/// requisição.
///
/// `sensitive` é uma flag de apresentação (mascarar na UI, não logar) — o
/// valor em si continua presente e legível aqui.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvironmentVariable {
    name: String,
    value: String,
    pub sensitive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum EnvironmentVariableError {
    #[error("nome da variável não pode ser vazio")]
    EmptyName,
    #[error("nome da variável não pode conter '{{' ou '}}'")]
    InvalidName,
}

impl EnvironmentVariable {
    pub fn new(
        name: impl Into<String>,
        value: impl Into<String>,
        sensitive: bool,
    ) -> Result<Self, EnvironmentVariableError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(EnvironmentVariableError::EmptyName);
        }
        if name.contains('{') || name.contains('}') {
            return Err(EnvironmentVariableError::InvalidName);
        }

        Ok(Self {
            name,
            value: value.into(),
            sensitive,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn value(&self) -> &str {
        &self.value
    }
}

/// Um conjunto nomeado de variáveis — ex.: "Development", "Production".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Environment {
    pub id: String,
    name: String,
    variables: Vec<EnvironmentVariable>,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum EnvironmentError {
    #[error("nome do ambiente não pode ser vazio")]
    EmptyName,
    #[error("variável '{0}' duplicada")]
    DuplicateVariable(String),
}

impl Environment {
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        variables: Vec<EnvironmentVariable>,
    ) -> Result<Self, EnvironmentError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(EnvironmentError::EmptyName);
        }

        let mut seen = HashSet::new();
        for variable in &variables {
            if !seen.insert(variable.name()) {
                return Err(EnvironmentError::DuplicateVariable(
                    variable.name().to_string(),
                ));
            }
        }

        Ok(Self {
            id: id.into(),
            name,
            variables,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn variables(&self) -> &[EnvironmentVariable] {
        &self.variables
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_valid_variable() {
        let variable =
            EnvironmentVariable::new("baseUrl", "https://api.example.com", false).unwrap();

        assert_eq!(variable.name(), "baseUrl");
        assert_eq!(variable.value(), "https://api.example.com");
        assert!(!variable.sensitive);
    }

    #[test]
    fn rejects_an_empty_variable_name() {
        assert_eq!(
            EnvironmentVariable::new("", "value", false),
            Err(EnvironmentVariableError::EmptyName)
        );
        assert_eq!(
            EnvironmentVariable::new("   ", "value", false),
            Err(EnvironmentVariableError::EmptyName)
        );
    }

    #[test]
    fn rejects_a_variable_name_with_braces() {
        assert_eq!(
            EnvironmentVariable::new("{{baseUrl}}", "value", false),
            Err(EnvironmentVariableError::InvalidName)
        );
    }

    #[test]
    fn accepts_an_environment_with_unique_variable_names() {
        let variables = vec![
            EnvironmentVariable::new("baseUrl", "https://api.example.com", false).unwrap(),
            EnvironmentVariable::new("token", "secret", true).unwrap(),
        ];

        let environment = Environment::new("env-1", "Development", variables.clone()).unwrap();

        assert_eq!(environment.name(), "Development");
        assert_eq!(environment.variables(), variables.as_slice());
    }

    #[test]
    fn rejects_an_empty_environment_name() {
        assert_eq!(
            Environment::new("env-1", "", vec![]),
            Err(EnvironmentError::EmptyName)
        );
    }

    #[test]
    fn rejects_duplicate_variable_names() {
        let variables = vec![
            EnvironmentVariable::new("baseUrl", "a", false).unwrap(),
            EnvironmentVariable::new("baseUrl", "b", false).unwrap(),
        ];

        assert_eq!(
            Environment::new("env-1", "Development", variables),
            Err(EnvironmentError::DuplicateVariable("baseUrl".to_string()))
        );
    }
}
