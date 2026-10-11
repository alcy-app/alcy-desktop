/// Método HTTP de uma requisição. `Post` é o padrão porque toda requisição
/// GraphQL de hoje é implicitamente um POST — `Request::new` usa
/// `HttpMethod::default()`, então nenhum chamador GraphQL precisa mudar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HttpMethod {
    Get,
    #[default]
    Post,
    Put,
    Patch,
    Delete,
    Head,
    Options,
}
