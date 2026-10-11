/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GITLAB_COM_CLIENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Versão do app (`src-tauri/tauri.conf.json`), injetada pelo Vite no build. */
declare const __APP_VERSION__: string
