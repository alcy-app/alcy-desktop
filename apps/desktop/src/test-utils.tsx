import type { ReactElement, ReactNode } from 'react'
import { render as rtlRender, type RenderOptions } from '@testing-library/react'
import { UpdateProvider } from './features/updates/UpdateProvider'
import { ThemeProvider } from './shared/appearance/ThemeProvider'
import { UiScaleProvider } from './shared/appearance/UiScaleProvider'
import { SchemaAutocompleteProvider } from './shared/schema-autocomplete/SchemaAutocompleteProvider'
import { LanguageProvider } from './shared/i18n/LanguageProvider'
import { GitlabProvider } from './shared/gitlab/GitlabProvider'
import { ProxyProvider } from './shared/proxy/ProxyProvider'
import { SecurityPreferencesProvider } from './shared/security/SecurityPreferencesProvider'
import { ShortcutsProvider } from './shared/shortcuts/ShortcutsProvider'
import { ToastProvider } from './shared/ui/Toast'

// eslint-disable-next-line react-refresh/only-export-components -- test-only utility, never hot-reloaded
export * from '@testing-library/react'

// eslint-disable-next-line react-refresh/only-export-components -- test-only utility, never hot-reloaded
function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
    <UiScaleProvider>
      <LanguageProvider>
        <ToastProvider>
          <SecurityPreferencesProvider>
            <ShortcutsProvider>
              <ProxyProvider>
                <GitlabProvider>
                  <UpdateProvider>
                    <SchemaAutocompleteProvider>{children}</SchemaAutocompleteProvider>
                  </UpdateProvider>
                </GitlabProvider>
              </ProxyProvider>
            </ShortcutsProvider>
          </SecurityPreferencesProvider>
        </ToastProvider>
      </LanguageProvider>
    </UiScaleProvider>
    </ThemeProvider>
  )
}

/** Wraps every render in `LanguageProvider` + `ToastProvider`, mirroring the composition root in `App.tsx`. */
export function render(ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  return rtlRender(ui, { wrapper: Providers, ...options })
}
