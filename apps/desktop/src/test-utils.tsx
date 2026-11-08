import type { ReactElement, ReactNode } from 'react'
import { fireEvent, render as rtlRender, type RenderOptions } from '@testing-library/react'
import { UpdateProvider } from './features/updates/UpdateProvider'
import { ThemeProvider } from './shared/appearance/ThemeProvider'
import { UiScaleProvider } from './shared/appearance/UiScaleProvider'
import { SchemaAutocompleteProvider } from './shared/schema-autocomplete/SchemaAutocompleteProvider'
import { LanguageProvider } from './shared/i18n/LanguageProvider'
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
                    <UpdateProvider>
                      <SchemaAutocompleteProvider>{children}</SchemaAutocompleteProvider>
                    </UpdateProvider>
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

/**
 * Hovers a `{{variable}}` or `:param` token of a `TemplateHighlightedField`.
 * Tokens let the pointer through to the `<input>` (so clicking and selecting
 * edit the text), and the field hit-tests the pointer against them — so the
 * pointer moves over the input at the token's position. jsdom has no layout:
 * a token without a rect gets one of its own, apart from the others.
 */
export function hoverTemplateToken(token: Element) {
  const input = templateFieldInput(token)
  let rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'> = token.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) {
    const fake = { left: 5000, top: 5000, right: 5040, bottom: 5016, width: 40, height: 16, x: 5000, y: 5000, toJSON: () => ({}) }
    Object.defineProperty(token, 'getBoundingClientRect', { configurable: true, value: () => fake })
    rect = fake
  }
  fireEvent.mouseMove(input, { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, buttons: 0 })
}

/** Moves the pointer off the field that holds `token`. */
export function unhoverTemplateToken(token: Element) {
  fireEvent.mouseLeave(templateFieldInput(token))
}

function templateFieldInput(token: Element): HTMLInputElement {
  const input = token.closest('.var-highlight-wrapper')?.querySelector('input')
  if (!input) throw new Error('The token is not inside a TemplateHighlightedField.')
  return input
}
