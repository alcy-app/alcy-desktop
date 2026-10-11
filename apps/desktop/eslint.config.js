import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['src/bindings/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tauri-apps/api', '@tauri-apps/api/*'],
              message:
                'Acesse capacidades do Tauri somente pela camada de bindings (src/bindings).',
            },
          ],
        },
      ],
    },
  },
  {
    // O webclient exportado roda num navegador comum, fora do app (ADR 0046):
    // nada de Tauri, bindings ou features do desktop.
    files: ['src/webclient/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tauri-apps/*', '**/bindings/**', '**/features/**', '**/shared/**', '!**/shared/**/*.css'],
              message: 'O webclient exportado não roda dentro do app: use só módulos de src/webclient.',
            },
          ],
        },
      ],
    },
  },
])
