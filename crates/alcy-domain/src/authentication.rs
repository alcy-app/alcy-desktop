/// Esquema de autenticação aplicado a uma requisição.
///
/// Campos vazios são estados representáveis (o usuário pode estar
/// preenchendo o formulário, ou uma importação de OpenAPI não carrega
/// segredos) e não são validados aqui.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Authentication {
    None,
    /// Herda a autenticação da pasta/coleção pai mais próxima que não seja
    /// `Inherit`; sem ancestral definido, equivale a `None`. Resolvida por
    /// `effective_authentication` antes de qualquer execução — os
    /// executores tratam `Inherit` como `None`.
    Inherit,
    /// Envia `name: value` como header de autenticação.
    CustomHeader {
        name: String,
        value: String,
    },
    Bearer {
        token: String,
    },
    Basic {
        username: String,
        password: String,
    },
    Digest {
        username: String,
        password: String,
    },
    /// Fluxo OAuth2 `client_credentials` apenas — outros fluxos exigem
    /// redirecionamento interativo e ficam fora do escopo atual. Token é
    /// buscado a cada execução (sem cache) por `alcy-http-auth`. `scope`
    /// vazio significa "nenhum escopo pedido" (não enviado ao token URL).
    OAuth2ClientCredentials {
        client_id: String,
        client_secret: String,
        token_url: String,
        scope: String,
    },
}
