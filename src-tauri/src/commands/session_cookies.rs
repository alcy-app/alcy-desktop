//! Cookies da sessão do app (spec 0108): um único jar em memória para as
//! requisições avulsas REST e GraphQL. Some ao fechar o app e nunca vai
//! para o disco nem para o histórico.

use serde::Deserialize;
use tauri::State;

use crate::commands::cookie_jar::{CookieJar, StoredCookieOutput};

#[derive(Default)]
pub struct SessionCookies(pub(crate) CookieJar);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCookieKey {
    pub domain: String,
    pub path: String,
    pub name: String,
}

#[tauri::command]
pub fn list_session_cookies(cookies: State<'_, SessionCookies>) -> Vec<StoredCookieOutput> {
    cookies.0.list()
}

#[tauri::command]
pub fn delete_session_cookie(key: SessionCookieKey, cookies: State<'_, SessionCookies>) {
    cookies.0.remove(&key.domain, &key.path, &key.name);
}

#[tauri::command]
pub fn clear_session_cookies(cookies: State<'_, SessionCookies>) {
    cookies.0.clear();
}
