import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Mesma versão que o Tauri grava no binário; usada nas novidades da versão.
const tauriConfig = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as {
  version: string
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(tauriConfig.version),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
})
