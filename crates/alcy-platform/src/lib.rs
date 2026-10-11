//! Integrações nativas do Alcy (ADR 0020): chaveiro do sistema e receptor do
//! retorno do login OAuth em `127.0.0.1`.

mod callback;
mod credentials;

pub use callback::{CALLBACK_PORT, CallbackError, CallbackServer};
pub use credentials::KeyringCredentialStore;
