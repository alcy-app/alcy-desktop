/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GITLAB_COM_CLIENT_ID?: string
  /** Application (client) ID registered in Microsoft Entra ID for OneDrive. */
  readonly VITE_ONEDRIVE_CLIENT_ID?: string
  /** Entra tenant for OneDrive login; empty means `common`. */
  readonly VITE_ONEDRIVE_TENANT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Versão do app (`src-tauri/tauri.conf.json`), injetada pelo Vite no build. */
declare const __APP_VERSION__: string
