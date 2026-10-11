//! Proxy de saída do Alcy (ADR 0019): monta o `reqwest::Client` conforme a
//! configuração (`alcy_domain::ProxySettings`) e avalia scripts PAC.
//!
//! Os executores HTTP guardam um `SharedHttpClient`, que pode ser
//! reconfigurado em runtime sem recriar os executores.

mod client;
mod pac;
mod system;

pub use client::{ProxyError, ProxyPlan, RequestClient, SharedHttpClient};
pub use pac::{PacDirective, PacScript};
